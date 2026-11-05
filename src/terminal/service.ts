/**
 * Thanh toán trên máy POS qua Payment Bridge API (POST /cloudMessages):
 * https://docs.poynt.com/app-integration/semiIntegration/payment-bridge/payment-actions.html
 *
 * Luồng: tạo dòng PENDING → gửi cloud message xuống máy → khách quẹt/chạm thẻ → máy POS POST kết quả về
 * /api/v1/terminal/callback/:id (kèm header bí mật riêng của giao dịch) → server GET lại transaction từ Poynt
 * để xác minh → APPROVED / DECLINED / CANCELLED → báo nas-order-api (callbackUrl) như paylink.
 */
import crypto from 'crypto';
import { config } from '../config';
import { getPosMerchant } from '../catalog/client';
import { deliverCallback } from '../paylink/callback';
import { envMerchant, getActiveTerminals, getTransaction, Merchant, sendCloudMessage } from '../poynt/service';
import * as store from './store';

export const SECRET_HEADER = 'X-Terminal-Secret';
/** Thời gian (giây) Poynt giữ lệnh khi chưa giao được xuống máy. */
export const DEFAULT_TTL = 60;
/** Chờ thêm (giây) sau ttl trước khi coi là EXPIRED, để kịp nhận RECEIVED nếu máy nhận lệnh sát hạn. */
export const EXPIRE_GRACE_SECONDS = 30;
/** Không gửi giao dịch mới xuống máy đang có sale/authorize PENDING trong khoảng này. */
const DEVICE_BUSY_MINUTES = 10;

const httpError = (status: number, message: string, details?: unknown) => Object.assign(new Error(message), { status, details });

export const merchantFor = (nasStoreId?: number): Promise<Merchant> =>
  nasStoreId ? getPosMerchant(nasStoreId) : Promise.resolve(envMerchant());

const merchantOfPayment = (p: store.TerminalPayment): Merchant => ({ businessId: p.businessId, storeId: p.storeId, deviceId: p.deviceId });

function callbackUrlFor(id: string) {
  return `${config.publicBaseUrl}/api/v1/terminal/callback/${id}`;
}

/** Chọn máy: deviceId truyền vào, hoặc DeviceId của store; phải là TERMINAL đã kích hoạt trong đúng StoreId. */
async function resolveDevice(m: Merchant, deviceId?: string): Promise<{ storeId: string; deviceId: string }> {
  if (!m.storeId) throw httpError(400, 'Poynt configuration is missing StoreId');
  const target = deviceId || m.deviceId;
  if (!target) throw httpError(400, 'deviceId is required (store has no default Poynt DeviceId)');
  const terminals = await getActiveTerminals(m);
  const t = terminals.find((x) => x.deviceId === target);
  if (!t) throw httpError(400, `Device ${target} is not an activated terminal of business ${m.businessId}`);
  if (t.storeId !== m.storeId) throw httpError(400, `Device ${target} belongs to store ${t.storeId}, not ${m.storeId}`);
  return { storeId: t.storeId, deviceId: t.deviceId };
}

async function send(p: store.TerminalPayment, data: Record<string, unknown>, ttl: number) {
  try {
    await sendCloudMessage({
      businessId: p.businessId,
      storeId: p.storeId,
      deviceId: p.deviceId,
      ttl,
      data: {
        callbackUrl: callbackUrlFor(p.id),
        'custom-http-header': `${SECRET_HEADER}: ${p.callbackSecret}`,
        enableStatusUpdates: true,
        ...data,
      },
    });
  } catch (e: any) {
    await store.complete(p.id, { status: 'FAILED', error: `cloudMessages: ${e.message}` });
    throw e;
  }
}

export type StartInput = {
  action: 'SALE' | 'AUTHORIZE';
  amount: number;
  currency: string;
  nasStoreId?: number;
  bookingId?: number;
  deviceId?: string;
  reference?: string;
  notes?: string;
  requestId?: string;
  callbackUrl?: string;
  allowTip?: boolean;
  ttl?: number;
};

/** Gửi sale/authorize xuống máy POS. Trả { payment, created } — created=false khi requestId đã tồn tại. */
export async function startPayment(input: StartInput) {
  const ttl = input.ttl ?? DEFAULT_TTL;
  if (input.requestId) {
    const existing = await store.getByRequestId(input.requestId);
    if (existing) return { payment: existing, created: false };
  }
  const m = await merchantFor(input.nasStoreId);
  const { storeId, deviceId } = await resolveDevice(m, input.deviceId);
  await expireStale();
  const busy = await store.findPendingOnDevice(deviceId, DEVICE_BUSY_MINUTES);
  if (busy) throw httpError(409, `Device is busy with pending payment ${busy.id}; cancel it or wait for its result`, { pendingId: busy.id });

  const p = await store.create({
    action: input.action, amount: input.amount, currency: input.currency, businessId: m.businessId, storeId, deviceId,
    nasStoreId: input.nasStoreId, bookingId: input.bookingId, reference: input.reference, notes: input.notes, requestId: input.requestId,
    callbackUrl: input.callbackUrl, ttl,
  });
  const payment: Record<string, unknown> = {
    amount: input.amount,
    currency: input.currency,
    referenceId: p.id,
    multiTender: false,
    disableTip: !input.allowTip,
    skipReceiptScreen: false,
  };
  if (input.action === 'AUTHORIZE') payment.authzOnly = true;
  const notes = [input.reference, input.notes].filter(Boolean).join(' / ');
  if (notes) payment.notes = notes;
  await send(p, { payment: JSON.stringify(payment) }, ttl);
  return { payment: p, created: true };
}

export type FollowUpInput = { amount?: number; requestId?: string; callbackUrl?: string; ttl?: number };

const FOLLOW_UP_RULES: Record<'CAPTURE' | 'VOID' | 'REFUND', store.TerminalAction[]> = {
  CAPTURE: ['AUTHORIZE'],
  VOID: ['AUTHORIZE', 'SALE'],
  REFUND: ['SALE', 'CAPTURE'],
};

/** capture / void / refund một giao dịch đã APPROVED, thực hiện trên máy POS. */
export async function followUp(parentId: string, action: 'CAPTURE' | 'VOID' | 'REFUND', input: FollowUpInput) {
  if (input.requestId) {
    const existing = await store.getByRequestId(input.requestId);
    if (existing) return { payment: existing, created: false };
  }
  const ttl = input.ttl ?? DEFAULT_TTL;
  const parent = await store.get(parentId);
  if (!parent) throw httpError(404, 'Terminal payment not found');
  if (!FOLLOW_UP_RULES[action].includes(parent.action)) {
    throw httpError(409, `Cannot ${action.toLowerCase()} a ${parent.action} payment`);
  }
  if (parent.status !== 'APPROVED' || !parent.transactionId) throw httpError(409, `Payment is ${parent.status}, expected APPROVED`);
  if (action === 'REFUND' && input.amount !== undefined && parent.amount !== undefined && input.amount > parent.amount) {
    throw httpError(400, 'Refund amount exceeds the original amount');
  }
  if (action !== 'REFUND' && input.amount !== undefined) throw httpError(400, `amount is only supported for refunds`);

  const p = await store.create({
    action, parentId: parent.id, amount: input.amount, currency: parent.currency, businessId: parent.businessId,
    storeId: parent.storeId, deviceId: parent.deviceId, nasStoreId: parent.nasStoreId, bookingId: parent.bookingId, reference: parent.reference,
    requestId: input.requestId, callbackUrl: input.callbackUrl ?? parent.callbackUrl, ttl,
  });
  const data: Record<string, unknown> = { action: action.toLowerCase(), transactionId: parent.transactionId, referenceId: p.id };
  if (action === 'REFUND' && input.amount !== undefined) {
    data.purchaseAmount = input.amount;
    data.currency = parent.currency;
  }
  await send(p, data, ttl);
  return { payment: p, created: true };
}

/** Huỷ giao dịch đang chờ khách trên máy. Kết quả về qua callback (status CANCELED). */
export async function cancelPayment(id: string) {
  const p = await store.get(id);
  if (!p) throw httpError(404, 'Terminal payment not found');
  if (p.status !== 'PENDING') throw httpError(409, `Payment is ${p.status}`);
  await sendCloudMessage({ businessId: p.businessId, storeId: p.storeId, deviceId: p.deviceId, ttl: 30, data: { action: 'cancelPayment' } });
  return p;
}

/** Khuyến nghị của Poynt: profile kết nối "PAYMENT BRIDGE" để máy không rớt kết nối cloud. */
export async function setPcmProfile(nasStoreId: number | undefined, deviceId?: string) {
  const m = await merchantFor(nasStoreId);
  const d = await resolveDevice(m, deviceId);
  await sendCloudMessage({ businessId: m.businessId, storeId: d.storeId, deviceId: d.deviceId, ttl: 86400, data: { action: 'setCustomPcmProfile' } });
  return d;
}

export function secretMatches(p: store.TerminalPayment, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(p.callbackSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Callback & xác minh ----------

const APPROVED_STATUSES: Record<store.TerminalAction, string[]> = {
  SALE: ['CAPTURED', 'AUTHORIZED'],
  AUTHORIZE: ['AUTHORIZED'],
  CAPTURE: ['CAPTURED', 'PARTIALLY_CAPTURED'],
  VOID: ['VOIDED'],
  REFUND: ['REFUNDED', 'PARTIALLY_REFUNDED'],
};

const referenceIdOf = (t: any): string | undefined =>
  (t?.references || []).find((r: any) => r?.customType === 'referenceId')?.id;

/** Chọn transaction của giao dịch này trong payload callback. */
function pickTransaction(p: store.TerminalPayment, body: any): any {
  const txns: any[] = Array.isArray(body?.transactions) ? body.transactions : [];
  return txns.find((t) => referenceIdOf(t) === p.id) || txns[txns.length - 1];
}

function notify(p: store.TerminalPayment) {
  if (!p.callbackUrl) return;
  void deliverCallback(p.callbackUrl, { terminalPaymentId: p.id }, (patch) => store.update(p.id, patch), p.id);
}

/** GET transaction từ Poynt rồi chốt trạng thái; không tin số liệu trong callback. */
export async function verifyAndComplete(p: store.TerminalPayment, transactionId: string): Promise<store.TerminalPayment> {
  const t: any = await getTransaction(merchantOfPayment(p), transactionId);
  const problems: string[] = [];
  if (t?.context?.businessId && t.context.businessId !== p.businessId) problems.push('businessId mismatch');
  if (t?.context?.storeDeviceId && t.context.storeDeviceId !== p.deviceId) problems.push(`device ${t.context.storeDeviceId}`);

  if (p.action === 'SALE' || p.action === 'AUTHORIZE') {
    // Bắt buộc: transaction phải mang referenceId của chính giao dịch này (chống dùng lại transaction khác)
    const ref = referenceIdOf(t);
    if (ref !== p.id) problems.push(`referenceId ${ref ?? 'missing'}`);
    const a = t?.amounts || {};
    const base = Number(a.transactionAmount ?? 0) - Number(a.tipAmount ?? 0) - Number(a.cashbackAmount ?? 0);
    if (base !== p.amount) problems.push(`amount ${base} != ${p.amount}`);
    if (a.currency && a.currency !== p.currency) problems.push(`currency ${a.currency}`);
  } else {
    const parent = p.parentId ? await store.get(p.parentId) : undefined;
    if (!parent?.transactionId || (t?.id !== parent.transactionId && t?.parentId !== parent.transactionId)) {
      problems.push('transaction is not related to the original payment');
    }
  }

  const card = t?.fundingSource?.card;
  const base = { transactionId, transactionStatus: t?.status, cardType: card?.type, cardLast4: card?.numberLast4 };
  let patch: Partial<store.TerminalPayment> & { status: store.TerminalStatus };
  if (problems.length) patch = { ...base, status: 'FAILED', error: `Verification failed: ${problems.join(', ')}` };
  else if (APPROVED_STATUSES[p.action].includes(t?.status)) patch = { ...base, status: 'APPROVED', error: undefined };
  else if (t?.status === 'DECLINED') patch = { ...base, status: 'DECLINED' };
  else patch = { ...base, status: 'FAILED', error: `Unexpected transaction status ${t?.status} for ${p.action}` };

  // fromExpired: máy báo kết quả sau khi đã EXPIRED — transaction đã xác minh thì vẫn phải ghi nhận
  const done = await store.complete(p.id, patch, { fromExpired: true });
  if (!done) return (await store.get(p.id))!; // đã được callback/sync khác chốt trước
  notify(done);
  return done;
}

/** Xử lý payload máy POS gửi về (chạy nền sau khi đã trả 200 cho máy). */
export async function processCallback(p: store.TerminalPayment, body: any): Promise<void> {
  const status = String(body?.status || '').toUpperCase();
  if (p.status !== 'PENDING' && p.status !== 'EXPIRED') return;
  // Đã EXPIRED: chỉ quan tâm khi máy báo có transaction (khách vẫn thanh toán được), bỏ qua RECEIVED/CANCELED muộn
  if (p.status === 'EXPIRED' && !pickTransaction(p, body)?.id) return;

  if (status === 'CANCELED' || status === 'CANCELLED') {
    const done = await store.complete(p.id, { status: 'CANCELLED', terminalStatus: 'CANCELED' });
    if (done) notify(done);
    return;
  }
  const txn = pickTransaction(p, body);
  if (!txn?.id) {
    if (status) await store.update(p.id, { terminalStatus: status }); // RECEIVED / STARTED
    return;
  }
  // Lưu transactionId trước để có thể sync lại nếu bước xác minh lỗi
  await store.update(p.id, { terminalStatus: status || 'PROCESSED', transactionId: txn.id });
  try {
    await verifyAndComplete(p, txn.id);
  } catch (e: any) {
    console.error(`[terminal] verify ${p.id} failed: ${e.message}`);
    await store.update(p.id, { error: `Verification error: ${e.message}` });
  }
}

/** Chuyển các giao dịch máy không phản hồi quá hạn sang EXPIRED và báo callbackUrl. `id` để chỉ xét một giao dịch. */
export async function expireStale(id?: string): Promise<store.TerminalPayment[]> {
  const expired = await store.expireStale(EXPIRE_GRACE_SECONDS, DEFAULT_TTL, id);
  for (const p of expired) {
    console.log(`[terminal] ${p.id} expired (device ${p.deviceId} did not respond)`);
    notify(p);
  }
  return expired;
}

/** Xác minh lại giao dịch PENDING đã có transactionId (vd khi lần xác minh trong callback bị lỗi mạng). */
export async function syncPayment(id: string) {
  const p = await store.get(id);
  if (!p) throw httpError(404, 'Terminal payment not found');
  if (p.status !== 'PENDING') return p;
  if (!p.transactionId) throw httpError(409, 'No transaction reported by the terminal yet');
  return verifyAndComplete(p, p.transactionId);
}
