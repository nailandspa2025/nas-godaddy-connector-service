/**
 * API thanh toán trên máy POS (Payment Bridge).
 *  - terminalRouter (/api/v1/terminal): server-to-server, cần x-api-key.
 *  - terminalCallbackRouter (/api/v1/terminal/callback): máy POS gọi về, xác thực bằng header bí mật của từng giao dịch.
 */
import { NextFunction, Request, Response, Router } from 'express';
import { config } from '../config';
import { deliverCallback } from '../paylink/callback';
import { requireAdmin } from '../poynt/routes';
import { getActiveTerminals } from '../poynt/service';
import * as service from './service';
import * as store from './store';

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

function optNasStoreId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw bad('nasStoreId must be a positive integer');
  return n;
}
function optString(body: any, key: string, max = 200): string | undefined {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw bad(`${key} must be a string (max ${max} chars)`);
  return v;
}
function optCallbackUrl(body: any): string | undefined {
  const v = optString(body, 'callbackUrl', 2000);
  if (v !== undefined && !/^https?:\/\/\S+$/.test(v)) throw bad('callbackUrl must be an http(s) URL');
  return v;
}
function optTtl(body: any): number | undefined {
  const v = body?.ttl;
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 10 || v > 86400) throw bad('ttl must be an integer between 10 and 86400 seconds');
  return v;
}

const view = (p: store.TerminalPayment) => store.publicView(p);

export const terminalRouter = Router();
terminalRouter.use(requireAdmin);

/** Máy POS đã kích hoạt của business (chọn deviceId). */
terminalRouter.get('/devices', h(async (req, res) => {
  const m = await service.merchantFor(optNasStoreId(req.query.nasStoreId));
  const terminals = await getActiveTerminals(m);
  res.json(m.storeId ? terminals.filter((t) => t.storeId === m.storeId) : terminals);
}));

/** Gửi profile kết nối PAYMENT BRIDGE xuống máy (khuyến nghị làm một lần cho mỗi máy). */
terminalRouter.post('/devices/pcm-profile', h(async (req, res) => {
  const d = await service.setPcmProfile(optNasStoreId(req.body?.nasStoreId), optString(req.body, 'deviceId'));
  res.status(202).json({ sent: true, ...d });
}));

/**
 * Bắt đầu thanh toán trên máy: { amount, action?: SALE|AUTHORIZE, nasStoreId?, deviceId?, reference?, notes?,
 * requestId?, callbackUrl?, allowTip?, ttl? }. Kết quả về sau qua callback → GET /payments/:id.
 */
terminalRouter.post('/payments', h(async (req, res) => {
  const b = req.body || {};
  if (!Number.isInteger(b.amount) || b.amount <= 0) throw bad('amount must be a positive integer (cents)');
  const action = b.action ?? 'SALE';
  if (!['SALE', 'AUTHORIZE'].includes(action)) throw bad('action must be SALE or AUTHORIZE');
  if (b.allowTip !== undefined && typeof b.allowTip !== 'boolean') throw bad('allowTip must be a boolean');
  const currency = optString(b, 'currency', 3) ?? config.poynt.currency;
  const { payment, created } = await service.startPayment({
    action,
    amount: b.amount,
    currency,
    nasStoreId: optNasStoreId(b.nasStoreId),
    deviceId: optString(b, 'deviceId'),
    reference: optString(b, 'reference'),
    notes: optString(b, 'notes', 500),
    requestId: optString(b, 'requestId'),
    callbackUrl: optCallbackUrl(b),
    allowTip: b.allowTip,
    ttl: optTtl(b),
  });
  res.status(created ? 202 : 200).json(view(payment));
}));

terminalRouter.get('/payments', h(async (req, res) => {
  const reference = typeof req.query.reference === 'string' ? req.query.reference : undefined;
  res.json((await store.list({ reference })).map(view));
}));

terminalRouter.get('/payments/:id', h(async (req, res) => {
  const p = await store.get(String(req.params.id));
  if (!p) return res.status(404).json({ error: 'Terminal payment not found' });
  const children = await store.list({ parentId: p.id });
  res.json({ ...view(p), operations: children.map(view) });
}));

terminalRouter.post('/payments/:id/cancel', h(async (req, res) => {
  const p = await service.cancelPayment(String(req.params.id));
  res.status(202).json({ cancelRequested: true, id: p.id });
}));

for (const action of ['CAPTURE', 'VOID', 'REFUND'] as const) {
  terminalRouter.post(`/payments/:id/${action.toLowerCase()}`, h(async (req, res) => {
    const b = req.body || {};
    if (b.amount !== undefined && (!Number.isInteger(b.amount) || b.amount <= 0)) throw bad('amount must be a positive integer (cents)');
    const { payment, created } = await service.followUp(String(req.params.id), action, {
      amount: b.amount,
      requestId: optString(b, 'requestId'),
      callbackUrl: optCallbackUrl(b),
      ttl: optTtl(b),
    });
    res.status(created ? 202 : 200).json(view(payment));
  }));
}

/** Xác minh lại với Poynt khi giao dịch còn PENDING nhưng máy đã báo transactionId. */
terminalRouter.post('/payments/:id/sync', h(async (req, res) => {
  res.json(view(await service.syncPayment(String(req.params.id))));
}));

/** Gửi lại callback cho nas-order-api. */
terminalRouter.post('/payments/:id/callback', h(async (req, res) => {
  const p = await store.get(String(req.params.id));
  if (!p) return res.status(404).json({ error: 'Terminal payment not found' });
  if (p.status === 'PENDING') return res.status(409).json({ error: 'Payment is still PENDING' });
  if (!p.callbackUrl) return res.status(400).json({ error: 'Payment has no callbackUrl' });
  await store.update(p.id, { callbackStatus: undefined });
  void deliverCallback(p.callbackUrl, { terminalPaymentId: p.id }, (patch) => store.update(p.id, patch), p.id);
  res.status(202).json({ queued: true });
}));

export const terminalCallbackRouter = Router();

/**
 * Máy POS POST kết quả. Máy chỉ chờ 3 giây nên trả 200 ngay sau khi kiểm tra secret,
 * phần xác minh với Poynt chạy nền.
 */
terminalCallbackRouter.post('/:id', h(async (req, res) => {
  const p = await store.get(String(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!service.secretMatches(p, req.get(service.SECRET_HEADER))) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ received: true });
  service.processCallback(p, req.body).catch((e) => console.error(`[terminal] callback ${p.id} failed: ${e.message}`));
}));
