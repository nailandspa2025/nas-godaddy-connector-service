/**
 * Báo cho hệ thống gọi (nas-order-api) khi có kết quả thanh toán.
 * Chỉ gửi id; bên nhận phải tự GET lại để xác minh. Thử lại với backoff; kết quả lưu qua `save`.
 */
import * as store from './store';

const RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postOnce(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => null);
  // nas-order-api trả 200 + { succeeded:false } khi lỗi nghiệp vụ
  if (!res.ok || data?.succeeded === false) {
    throw new Error(`callback ${res.status}: ${data?.message ?? 'failed'}`);
  }
}

type Save = (patch: { callbackStatus: 'DONE' | 'FAILED'; callbackError?: string }) => Promise<unknown>;

/** POST body tới url, thử lại 0s/5s/30s/2m; lưu DONE/FAILED sau mỗi lần. */
export async function deliverCallback(url: string, body: Record<string, unknown>, save: Save, label: string): Promise<void> {
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    await sleep(RETRY_DELAYS_MS[i]);
    try {
      await postOnce(url, body);
      await save({ callbackStatus: 'DONE', callbackError: undefined });
      return;
    } catch (e: any) {
      console.warn(`[callback] ${label} attempt ${i + 1} failed: ${e.message}`);
      await save({ callbackStatus: 'FAILED', callbackError: e.message }).catch((err) => console.error('[callback] save failed', err.message));
    }
  }
}

export async function notifyPaid(paylinkId: string): Promise<void> {
  const p = await store.get(paylinkId);
  if (!p?.callbackUrl || p.callbackStatus === 'DONE') return;
  await deliverCallback(p.callbackUrl, { paylinkId }, (patch) => store.update(paylinkId, patch), paylinkId);
}
