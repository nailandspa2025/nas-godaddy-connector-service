import { NextFunction, Request, Response, Router } from 'express';
import { config } from '../config';
import { getPoyntMerchant } from '../catalog/client';
import { chargeNonce, envMerchant, getStoreName, Merchant, resolveContext } from '../poynt/service';
import { notifyPaid } from './callback';
import * as store from './store';

const linkUrl = (id: string) => `${config.paymentPageUrl}/${id}`;
const withUrl = (p: store.Paylink) => ({ ...p, url: linkUrl(p.id) });

/** Cấu hình Poynt của paylink: theo store NAS nếu có, ngược lại lấy từ .env. */
const merchantOf = (p: store.Paylink): Promise<Merchant> =>
  p.nasStoreId ? getPoyntMerchant(p.nasStoreId) : Promise.resolve(envMerchant());

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (config.adminApiKey && req.get('x-api-key') !== config.adminApiKey) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key' });
  }
  next();
}

// Chống double-click: mỗi paylink chỉ xử lý một lần charge tại một thời điểm
const charging = new Set<string>();

export const adminRouter = Router();
adminRouter.use(requireAdmin);

/** Tạo paylink. amount tính bằng cents (1050 = $10.50). */
adminRouter.post('/', async (req, res, next) => {
  const { amount, currency = config.poynt.currency, description = '', reference, expiresAt, nasStoreId, callbackUrl } = req.body || {};
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive integer (cents)' });
  }
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return res.status(400).json({ error: 'expiresAt must be an ISO date' });
  }
  if (nasStoreId !== undefined && (!Number.isInteger(nasStoreId) || nasStoreId <= 0)) {
    return res.status(400).json({ error: 'nasStoreId must be a positive integer' });
  }
  if (callbackUrl !== undefined && callbackUrl !== null && !/^https?:\/\/\S+$/.test(callbackUrl)) {
    return res.status(400).json({ error: 'callbackUrl must be an http(s) URL' });
  }
  try {
    // Kiểm tra store đã cấu hình Poynt trước khi phát link cho khách
    if (nasStoreId) await getPoyntMerchant(nasStoreId);
  } catch (e) {
    return next(e);
  }
  const p = await store.create({ amount, currency, description: String(description), reference, expiresAt, nasStoreId, callbackUrl: callbackUrl || undefined });
  res.status(201).json(withUrl(p));
});

adminRouter.get('/', async (_req, res) => res.json((await store.list()).map(withUrl)));

adminRouter.get('/:id', async (req, res) => {
  const p = await store.get(req.params.id);
  return p ? res.json(withUrl(p)) : res.status(404).json({ error: 'Payment link not found' });
});

/** Gửi lại callback (vd khi order-api từng lỗi). */
adminRouter.post('/:id/callback', async (req, res) => {
  const p = await store.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payment link not found' });
  if (p.status !== 'PAID') return res.status(409).json({ error: `Payment link is ${p.status}` });
  if (!p.callbackUrl) return res.status(400).json({ error: 'Payment link has no callbackUrl' });
  await store.update(p.id, { callbackStatus: undefined });
  void notifyPaid(p.id);
  res.status(202).json({ queued: true });
});

adminRouter.post('/:id/cancel', async (req, res) => {
  const p = await store.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payment link not found' });
  if (p.status !== 'ACTIVE') return res.status(409).json({ error: `Payment link is ${p.status}` });
  res.json(withUrl(await store.update(p.id, { status: 'CANCELLED' })));
});

export const publicRouter = Router();

/** Thông tin hiển thị cho trang thanh toán (không lộ dữ liệu nội bộ). */
publicRouter.get('/:id', async (req, res, next) => {
  const p = await store.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payment link not found' });
  let merchant: Merchant;
  let poyntStoreId: string | null;
  try {
    merchant = await merchantOf(p);
    poyntStoreId = merchant.storeId ?? (await resolveContext(merchant)).storeId;
  } catch (e) {
    return next(e);
  }
  res.json({
    id: p.id,
    amount: p.amount,
    currency: p.currency,
    description: p.description,
    reference: p.reference,
    merchantName: await getStoreName(merchant),
    paidAt: p.paidAt,
    transactionId: p.status === 'PAID' ? p.transactionId : undefined,
    status: store.isExpired(p) && p.status === 'ACTIVE' ? 'EXPIRED' : p.status,
    collect: {
      sdkUrl: config.poynt.collectSdkUrl,
      businessId: merchant.businessId,
      storeId: poyntStoreId,
      applicationId: config.poynt.applicationId,
    },
  });
});

/** Khách thanh toán: nhận nonce từ Poynt Collect, số tiền lấy từ paylink phía server. */
publicRouter.post('/:id/pay', async (req, res, next) => {
  const id = req.params.id;
  const p = await store.get(id);
  if (!p) return res.status(404).json({ error: 'Payment link not found' });
  if (p.status !== 'ACTIVE') return res.status(409).json({ error: `This payment link is already ${p.status.toLowerCase()}` });
  if (store.isExpired(p)) return res.status(410).json({ error: 'This payment link has expired' });
  const { nonce, email } = req.body || {};
  if (!nonce) return res.status(400).json({ error: 'Missing card nonce' });
  if (charging.has(id)) return res.status(409).json({ error: 'A payment is already being processed for this link' });

  charging.add(id);
  try {
    const attempt = await store.nextAttempt(id);
    const merchant = await merchantOf(p);
    const txn = await chargeNonce(merchant, {
      nonce,
      amount: p.amount,
      currency: p.currency,
      requestId: `${id}-${attempt}`,
      receiptEmailAddress: email || undefined,
      notes: p.reference ? `Paylink ${id} / ${p.reference}` : `Paylink ${id}`,
    });
    const approved = ['CAPTURED', 'AUTHORIZED'].includes(txn?.status);
    if (approved) {
      await store.update(id, { status: 'PAID', paidAt: new Date().toISOString(), transactionId: txn.id });
      void notifyPaid(id); // chạy nền, không chặn response cho khách
    }
    res.status(approved ? 200 : 402).json({
      approved,
      transactionId: txn?.id,
      status: txn?.status,
      paidAt: approved ? new Date().toISOString() : undefined,
      card: txn?.fundingSource?.card
        ? { type: txn.fundingSource.card.type, last4: txn.fundingSource.card.numberLast4 }
        : undefined,
    });
  } catch (e) {
    next(e);
  } finally {
    charging.delete(id);
  }
});
