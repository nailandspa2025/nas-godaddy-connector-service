/**
 * Lấy cấu hình Poynt của từng store NAS từ nas-catalog-api:
 * - PaymentMethod.Poynt = 10: paylink / charge online
 * - PaymentMethod.PosPayment = 11: thanh toán trên máy POS (Payment Bridge), cấu hình riêng
 */
import { config } from '../config';
import type { Merchant } from '../poynt/service';

export const POYNT_PAYMENT_METHOD = 10;
export const POS_PAYMENT_METHOD = 11;
const METHOD_NAMES: Record<number, string> = { [POYNT_PAYMENT_METHOD]: 'Poynt', [POS_PAYMENT_METHOD]: 'POS Payment' };
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { value: Merchant; expiresAt: number }>();

type Setting = { key: string; value?: string | null };
type ApiResponse = {
  succeeded: boolean;
  message?: string;
  data?: { paymentMethod: number; isActive: boolean; settings: Setting[] } | null;
};

const getSetting = (settings: Setting[], key: string) =>
  settings.find((s) => s.key?.toLowerCase() === key.toLowerCase())?.value?.trim() || null;

export async function getPoyntMerchant(nasStoreId: number, paymentMethod = POYNT_PAYMENT_METHOD): Promise<Merchant> {
  const key = `${nasStoreId}:${paymentMethod}`;
  const name = METHOD_NAMES[paymentMethod] ?? `payment method ${paymentMethod}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (!config.catalogApiUrl) throw Object.assign(new Error('CATALOG_API_URL is not configured'), { status: 500 });

  const url = `${config.catalogApiUrl}/api/v1/stores/payment-provider?storeId=${nasStoreId}&paymentMethod=${paymentMethod}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch (e: any) {
    // Lỗi mạng (DNS, connection refused, timeout): báo rõ thay vì "fetch failed"
    throw Object.assign(new Error(`Cannot reach nas-catalog-api at ${config.catalogApiUrl}`), {
      status: 502,
      details: e.cause?.code || e.cause?.message || e.message,
    });
  }
  const body = (await res.json().catch(() => null)) as ApiResponse | null;
  if (!res.ok || !body?.succeeded || !body.data) {
    throw Object.assign(new Error(`Store ${nasStoreId} has no active ${name} configuration`), {
      status: 400,
      details: body?.message ?? `catalog ${res.status}`,
    });
  }

  const businessId = getSetting(body.data.settings, 'BusinessId');
  if (!businessId) throw Object.assign(new Error(`Store ${nasStoreId} is missing the ${name} BusinessId`), { status: 400 });
  const value: Merchant = {
    businessId,
    storeId: getSetting(body.data.settings, 'StoreId'),
    deviceId: getSetting(body.data.settings, 'DeviceId'),
  };
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Cấu hình máy POS (PaymentMethod.PosPayment = 11) của store NAS. */
export const getPosMerchant = (nasStoreId: number) => getPoyntMerchant(nasStoreId, POS_PAYMENT_METHOD);

const nameCache = new Map<number, { value: string; expiresAt: number }>();

/** Tên cửa hàng hiển thị trên trang thanh toán (catalog storeName); lỗi thì trả chuỗi rỗng. */
export async function getStoreName(nasStoreId: number): Promise<string> {
  const hit = nameCache.get(nasStoreId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (!config.catalogApiUrl) return '';
  try {
    const res = await fetch(`${config.catalogApiUrl}/api/v1/stores/${nasStoreId}`, { headers: { Accept: 'application/json' } });
    const body: any = await res.json().catch(() => null);
    const value: string = (res.ok && body?.succeeded && body.data?.storeName) || '';
    nameCache.set(nasStoreId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    return '';
  }
}
