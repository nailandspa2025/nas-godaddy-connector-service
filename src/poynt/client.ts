/** HTTP client gọi Poynt API: gắn bearer token, thử lại 1 lần khi 401. */
import crypto from 'crypto';
import { config } from '../config';
import { getAccessToken } from './auth';

export class PoyntError extends Error {
  constructor(message: string, public status: number, public details: unknown) {
    super(message);
    this.name = 'PoyntError';
  }
}

type Opts = { body?: unknown; requestId?: string };

async function request<T>(method: string, path: string, opts: Opts = {}, retried = false): Promise<T> {
  const token = await getAccessToken({ force: retried });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'api-version': '1.2',
    // Cùng Poynt-Request-Id => Poynt không xử lý trùng giao dịch
    'Poynt-Request-Id': opts.requestId || crypto.randomUUID(),
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(config.poynt.apiUrl + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !retried) return request<T>(method, path, opts, true);

  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* giữ text */ }
  if (!res.ok) throw new PoyntError(data?.message || `Poynt API error ${res.status} ${method} ${path}`, res.status, data);
  return data as T;
}

export const poynt = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: unknown, opts: Omit<Opts, 'body'> = {}) => request<T>('POST', path, { ...opts, body }),
};
