/** Lấy cấu hình Poynt của từng store NAS từ nas-catalog-api (PaymentMethod.Poynt = 10). */
import { config } from '../config';
import type { Merchant } from '../poynt/service';

const POYNT_PAYMENT_METHOD = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<number, { value: Merchant; expiresAt: number }>();

type Setting = { key: string; value?: string | null };
type ApiResponse = {
  succeeded: boolean;
  message?: string;
  data?: { paymentMethod: number; isActive: boolean; settings: Setting[] } | null;
};

const getSetting = (settings: Setting[], key: string) =>
  settings.find((s) => s.key?.toLowerCase() === key.toLowerCase())?.value?.trim() || null;

export async function getPoyntMerchant(nasStoreId: number): Promise<Merchant> {
  const hit = cache.get(nasStoreId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (!config.catalogApiUrl) throw Object.assign(new Error('CATALOG_API_URL is not configured'), { status: 500 });

  const url = `${config.catalogApiUrl}/api/v1/stores/payment-provider?storeId=${nasStoreId}&paymentMethod=${POYNT_PAYMENT_METHOD}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = (await res.json().catch(() => null)) as ApiResponse | null;
  if (!res.ok || !body?.succeeded || !body.data) {
    throw Object.assign(new Error(`Store ${nasStoreId} has no active Poynt configuration`), {
      status: 400,
      details: body?.message ?? `catalog ${res.status}`,
    });
  }

  const businessId = getSetting(body.data.settings, 'BusinessId');
  if (!businessId) throw Object.assign(new Error(`Store ${nasStoreId} is missing the Poynt BusinessId`), { status: 400 });
  const value: Merchant = {
    businessId,
    storeId: getSetting(body.data.settings, 'StoreId'),
    deviceId: getSetting(body.data.settings, 'DeviceId'),
  };
  cache.set(nasStoreId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}
