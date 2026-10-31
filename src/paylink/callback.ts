/**
 * Báo cho hệ thống tạo paylink (nas-order-api) khi paylink PAID.
 * Chỉ gửi paylinkId; bên nhận phải tự GET /api/paylinks/:id để xác minh.
 * Thử lại với backoff; kết quả lưu vào paylink.callbackStatus.
 */
import * as store from './store';

const RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postOnce(url: string, paylinkId: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ paylinkId }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => null);
  // nas-order-api trả 200 + { succeeded:false } khi lỗi nghiệp vụ
  if (!res.ok || body?.succeeded === false) {
    throw new Error(`callback ${res.status}: ${body?.message ?? 'failed'}`);
  }
}

export async function notifyPaid(paylinkId: string): Promise<void> {
  const p = store.get(paylinkId);
  if (!p?.callbackUrl || p.callbackStatus === 'DONE') return;

  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    await sleep(RETRY_DELAYS_MS[i]);
    try {
      await postOnce(p.callbackUrl, paylinkId);
      store.update(paylinkId, { callbackStatus: 'DONE', callbackError: undefined });
      return;
    } catch (e: any) {
      console.warn(`[callback] ${paylinkId} attempt ${i + 1} failed: ${e.message}`);
      store.update(paylinkId, { callbackStatus: 'FAILED', callbackError: e.message });
    }
  }
}
