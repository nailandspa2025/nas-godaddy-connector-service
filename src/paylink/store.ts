/** Lưu paylink vào file JSON (demo). Production: thay bằng database. */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

export type PaylinkStatus = 'ACTIVE' | 'PAID' | 'CANCELLED';

export type Paylink = {
  id: string;
  amount: number; // cents
  currency: string;
  description: string;
  reference?: string;
  nasStoreId?: number; // store NAS (catalog) — dùng lấy cấu hình Poynt; không có thì dùng .env
  status: PaylinkStatus;
  expiresAt?: string;
  createdAt: string;
  paidAt?: string;
  transactionId?: string;
  attempts: number; // số lần charge, dùng sinh Poynt-Request-Id cho mỗi lần thử
  callbackUrl?: string; // POST { paylinkId } khi PAID (vd nas-order-api /payments/poynt-callback)
  callbackStatus?: 'DONE' | 'FAILED';
  callbackError?: string;
};

function load(): Record<string, Paylink> {
  if (!fs.existsSync(config.dataFile)) return {};
  return JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
}

function save(all: Record<string, Paylink>) {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  fs.writeFileSync(config.dataFile, JSON.stringify(all, null, 2));
}

export function create(input: Pick<Paylink, 'amount' | 'currency' | 'description' | 'reference' | 'expiresAt' | 'nasStoreId' | 'callbackUrl'>): Paylink {
  const all = load();
  const id = `pl_${crypto.randomBytes(9).toString('base64url')}`;
  all[id] = { ...input, id, status: 'ACTIVE', createdAt: new Date().toISOString(), attempts: 0 };
  save(all);
  return all[id];
}

export function get(id: string): Paylink | undefined {
  return load()[id];
}

export function list(): Paylink[] {
  return Object.values(load()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function update(id: string, patch: Partial<Paylink>): Paylink {
  const all = load();
  if (!all[id]) throw new Error(`Paylink ${id} does not exist`);
  all[id] = { ...all[id], ...patch };
  save(all);
  return all[id];
}

export function isExpired(p: Paylink): boolean {
  return !!p.expiresAt && new Date(p.expiresAt).getTime() < Date.now();
}
