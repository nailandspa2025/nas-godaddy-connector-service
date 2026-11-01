import { config } from '../config';
import { poynt } from './client';

/** Business Poynt mà app được cấp quyền; storeId/deviceId tuỳ chọn. */
export type Merchant = { businessId: string; storeId: string | null; deviceId: string | null };

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

export async function getStores(m: Merchant) {
  return poynt.get(`${biz(m)}/stores`);
}

export type ChargeInput = {
  nonce: string;
  amount: number; // cents
  currency: string;
  requestId: string;
  receiptEmailAddress?: string;
  notes?: string;
};

/** Charge nonce từ Poynt Collect: POST /businesses/{id}/cards/tokenize/charge */
export async function chargeNonce(m: Merchant, input: ChargeInput) {
  const context = resolveContext(m);
  const body: Record<string, unknown> = {
    action: 'SALE',
    context,
    amounts: { transactionAmount: input.amount, orderAmount: input.amount, currency: input.currency },
    fundingSource: {
      nonce: input.nonce,
      entryDetails: { customerPresenceStatus: 'ECOMMERCE', entryMode: 'KEYED' },
    },
  };
  if (input.receiptEmailAddress) {
    body.emailReceipt = true;
    body.receiptEmailAddress = input.receiptEmailAddress;
  }
  if (input.notes) body.notes = input.notes;
  return poynt.post(`${biz(m)}/cards/tokenize/charge`, body, { requestId: input.requestId });
}
