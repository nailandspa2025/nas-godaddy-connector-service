import { config } from '../config';
import { poynt } from './client';

/** Business Poynt mà app được cấp quyền; storeId/deviceId tuỳ chọn. */
export type Merchant = {
  businessId: string;
  storeId: string | null;
  deviceId: string | null;
  timeoutSeconds?: number; // hạn giao dịch trên máy POS (setting TimeoutSeconds của store)
};

/** Merchant mặc định từ .env (dùng khi paylink không gắn store NAS). */
export function envMerchant(): Merchant {
  const { businessId, storeId, deviceId } = config.poynt;
  if (!businessId) throw Object.assign(new Error('POYNT_BUSINESS_ID is not configured'), { status: 500 });
  return { businessId, storeId, deviceId };
}

const biz = (m: Merchant) => `/businesses/${encodeURIComponent(m.businessId)}`;

export type Context = { businessId: string; storeId: string; storeDeviceId: string };

/** Context charge lấy hoàn toàn từ cấu hình store trong catalog (không dò trên Poynt). */
export function resolveContext(m: Merchant): Context {
  const { businessId, storeId, deviceId } = m;
  const missing = [!storeId && 'StoreId', !deviceId && 'DeviceId'].filter(Boolean);
  if (missing.length) {
    throw Object.assign(new Error(`Poynt configuration is missing ${missing.join(' and ')}`), { status: 400 });
  }
  return { businessId, storeId: storeId!, storeDeviceId: deviceId! };
}

/** GET /businesses/{id}/stores — store + storeDevices (deviceId) của business. */
export async function getStores(m: Merchant) {
  return poynt.get(`${biz(m)}/stores`);
}

export type Terminal = { deviceId: string; serialNumber?: string; name?: string; storeId: string; storeName?: string };

/** Máy POS đã kích hoạt (storeDevices type TERMINAL, status ACTIVATED) của business. */
export async function getActiveTerminals(m: Merchant): Promise<Terminal[]> {
  const stores: any[] = (await getStores(m)) || [];
  return stores.flatMap((s) =>
    (s.storeDevices || [])
      .filter((d: any) => d.type === 'TERMINAL' && d.status === 'ACTIVATED' && d.deviceId)
      .map((d: any) => ({ deviceId: d.deviceId, serialNumber: d.serialNumber, name: d.name, storeId: s.id, storeName: s.displayName })),
  );
}

/** GET /businesses/{id}/transactions/{transactionId} */
export async function getTransaction(m: Merchant, transactionId: string) {
  return poynt.get(`${biz(m)}/transactions/${encodeURIComponent(transactionId)}`);
}

export type CloudMessage = { businessId: string; storeId: string; deviceId: string; ttl: number; data: Record<string, unknown> };

/**
 * POST /cloudMessages — gửi lệnh xuống máy POS (Payment Bridge). `data` được serialize thành chuỗi JSON theo tài liệu.
 * Cần quyền "Cloud Messages" WRITE cho app.
 */
export async function sendCloudMessage(msg: CloudMessage) {
  return poynt.post('/cloudMessages', { ...msg, data: JSON.stringify(msg.data) });
}

/** GET /businesses/{id} — thông tin business (attributes.allowACH...). */
export async function getBusiness(m: Merchant) {
  return poynt.get(`${biz(m)}`);
}

const ACH_CACHE_TTL_MS = 5 * 60 * 1000;
const achCache = new Map<string, { value: boolean; expiresAt: number }>();

/** ACH chỉ được bật khi business có attributes.allowACH = "1" (thiếu hoặc "0" = không hỗ trợ). Cache 5 phút. */
export async function isAchAllowed(m: Merchant): Promise<boolean> {
  const hit = achCache.get(m.businessId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const business: any = await getBusiness(m);
  const value = String(business?.attributes?.allowACH ?? '0') === '1';
  achCache.set(m.businessId, { value, expiresAt: Date.now() + ACH_CACHE_TTL_MS });
  return value;
}

// ---------- Apple Pay ----------

export type ApplePayRegistration = {
  registerDomains?: string[];
  unregisterDomains?: string[];
  merchantName?: string;
  merchantUrl?: string;
};

/** POST /businesses/{id}/apple-pay/registration — đăng ký/huỷ domain hiển thị nút Apple Pay. */
export async function updateApplePayRegistration(m: Merchant, input: ApplePayRegistration) {
  return poynt.post(`${biz(m)}/apple-pay/registration`, input);
}

/**
 * GET /businesses/{id}/apple-pay/domain-association-file — nội dung file cần host tại
 * https://{domain}/.well-known/apple-developer-merchantid-domain-association
 */
export async function getApplePayDomainAssociationFile(m: Merchant) {
  return poynt.get(`${biz(m)}/apple-pay/domain-association-file`);
}

// ---------- Tokenize / Charge ----------

/** Thoả thuận lưu thẻ (Card on File) — lấy từ response nonce của Poynt Collect khi khách chọn lưu thẻ. */
export type CardAgreement = Record<string, unknown>;

export type TokenizeInput = { nonce: string; saveCardOnFile?: boolean; cardAgreement?: CardAgreement; requestId?: string };

/**
 * POST /businesses/{id}/cards/tokenize — đổi nonce lấy payment token để charge nhiều lần.
 * Card on File: saveCardOnFile=true + card.cardAgreement. Token trả về phải được lưu phía người gọi.
 */
export async function tokenizeNonce(m: Merchant, input: TokenizeInput) {
  const body: Record<string, unknown> = { nonce: input.nonce };
  if (input.saveCardOnFile) body.saveCardOnFile = true;
  if (input.cardAgreement) body.card = { cardAgreement: input.cardAgreement };
  return poynt.post(`${biz(m)}/cards/tokenize`, body, { requestId: input.requestId });
}

export type ChargeAction = 'SALE' | 'AUTHORIZE';
export type CofIntent = 'UNSCHEDULED_COF_TXN' | 'RECURRING_COF_TXN';
export type TransactionFee = { amount: number; [k: string]: unknown };
export type Address = Record<string, unknown>;

/** Nguồn tiền: đúng một trong nonce (Poynt Collect) hoặc cardToken (payment token đã lưu). */
export type FundingInput = { nonce?: string; cardToken?: string };

export type ChargeRequest = FundingInput & {
  amount: number; // cents — orderAmount (chưa gồm phí)
  currency: string;
  requestId: string;
  action?: ChargeAction;
  intent?: CofIntent;
  mit?: boolean;
  /** Fee từ eligible-fees (surcharge); transactionAmount = amount + tổng fee.amount */
  transactionFees?: TransactionFee[];
  shippingAddress?: Address;
  receiptEmailAddress?: string;
  notes?: string;
};

function fundingSource(f: FundingInput) {
  if (!!f.nonce === !!f.cardToken) {
    throw Object.assign(new Error('Exactly one of nonce or cardToken is required'), { status: 400 });
  }
  return {
    ...(f.nonce ? { nonce: f.nonce } : { cardToken: f.cardToken }),
    entryDetails: { customerPresenceStatus: 'ECOMMERCE', entryMode: 'KEYED' },
  };
}

function transactionBody(m: Merchant, input: Omit<ChargeRequest, 'requestId'>) {
  const feeTotal = (input.transactionFees || []).reduce((sum, f) => sum + f.amount, 0);
  const body: Record<string, unknown> = {
    action: input.action || 'SALE',
    context: resolveContext(m),
    amounts: {
      transactionAmount: input.amount + feeTotal,
      orderAmount: input.amount,
      currency: input.currency,
      ...(input.transactionFees?.length ? { transactionFees: input.transactionFees } : {}),
    },
    fundingSource: fundingSource(input),
  };
  if (input.intent) body.intent = input.intent;
  if (input.mit !== undefined) body.mit = input.mit;
  if (input.shippingAddress) body.shippingAddress = input.shippingAddress;
  if (input.receiptEmailAddress) {
    body.emailReceipt = true;
    body.receiptEmailAddress = input.receiptEmailAddress;
  }
  if (input.notes) body.notes = input.notes;
  return body;
}

/** POST /businesses/{id}/cards/tokenize/charge — charge bằng nonce hoặc cardToken (COF, surcharge). */
export async function charge(m: Merchant, input: ChargeRequest) {
  return poynt.post(`${biz(m)}/cards/tokenize/charge`, transactionBody(m, input), { requestId: input.requestId });
}

/**
 * POST /businesses/{id}/transactions/eligible-fees — kiểm tra surcharge trước khi charge
 * (chỉ áp dụng cho thẻ credit). Trả { fees: [...] }; fee được dùng làm transactionFees khi charge.
 */
export async function getEligibleFees(m: Merchant, input: Omit<ChargeRequest, 'requestId' | 'transactionFees' | 'intent' | 'mit'>) {
  return poynt.post(`${biz(m)}/transactions/eligible-fees`, transactionBody(m, input));
}

export type ChargeInput = {
  nonce: string;
  amount: number; // cents
  currency: string;
  requestId: string;
  receiptEmailAddress?: string;
  notes?: string;
};

/** Charge nonce từ Poynt Collect (SALE) — dùng cho paylink. */
export async function chargeNonce(m: Merchant, input: ChargeInput) {
  return charge(m, { ...input, action: 'SALE' });
}
