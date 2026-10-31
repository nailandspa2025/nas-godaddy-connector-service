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
const cacheKey = (m: Merchant) => `${m.businessId}|${m.storeId ?? ''}|${m.deviceId ?? ''}`;

export type Context = { businessId: string; storeId: string; storeDeviceId: string };
const contextCache = new Map<string, Context>();

/** storeId/storeDeviceId: lấy từ cấu hình, thiếu thì lấy store ACTIVE + device ACTIVATED đầu tiên. */
export async function resolveContext(m: Merchant): Promise<Context> {
  const { businessId, storeId, deviceId } = m;
  if (storeId && deviceId) return { businessId, storeId, storeDeviceId: deviceId };
  const cached = contextCache.get(cacheKey(m));
  if (cached) return cached;

  const stores: any[] = (await poynt.get(`${biz(m)}/stores`)) || [];
  const store = stores.find((s) => (storeId ? s.id === storeId : s.status === 'ACTIVE')) || stores[0];
  if (!store) throw new Error(`No store found for business ${businessId}`);
  const devices: any[] = store.storeDevices || [];
  const device = devices.find((d) => d.status === 'ACTIVATED') || devices[0];
  if (!deviceId && !device) throw new Error(`Store ${store.id} has no device`);

  const context = { businessId, storeId: store.id, storeDeviceId: deviceId || device.deviceId };
  contextCache.set(cacheKey(m), context);
  return context;
}

export async function getStores(m: Merchant) {
  return poynt.get(`${biz(m)}/stores`);
}

const storeNameCache = new Map<string, string>();
/** Tên cửa hàng hiển thị trên trang thanh toán; lỗi thì trả chuỗi rỗng. */
export async function getStoreName(m: Merchant): Promise<string> {
  const key = cacheKey(m);
  const cached = storeNameCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const { storeId } = await resolveContext(m);
    const store = await poynt.get(`${biz(m)}/stores/${encodeURIComponent(storeId)}`);
    const name = store?.displayName || store?.name || '';
    storeNameCache.set(key, name);
    return name;
  } catch {
    return '';
  }
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
  const context = await resolveContext(m);
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
