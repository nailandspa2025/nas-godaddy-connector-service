/** Lưu paylink trong PostgreSQL (bảng paylinks, xem src/db.ts). */
import crypto from 'crypto';
import { pool } from '../db';

export type PaylinkStatus = 'ACTIVE' | 'PAID' | 'CANCELLED';

export type Paylink = {
  id: string;
  amount: number; // cents
  currency: string;
  description: string;
  reference?: string;
  nasStoreId?: number; // store NAS (catalog) — dùng lấy cấu hình Poynt; không có thì dùng .env
  bookingId?: number; // booking bên nas-order-api
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

/** Field của Paylink → cột trong bảng. */
const COLUMNS: Record<keyof Paylink, string> = {
  id: 'id',
  amount: 'amount',
  currency: 'currency',
  description: 'description',
  reference: 'reference',
  nasStoreId: 'nas_store_id',
  bookingId: 'booking_id',
  status: 'status',
  expiresAt: 'expires_at',
  createdAt: 'created_at',
  paidAt: 'paid_at',
  transactionId: 'transaction_id',
  attempts: 'attempts',
  callbackUrl: 'callback_url',
  callbackStatus: 'callback_status',
  callbackError: 'callback_error',
};

/** Row DB → Paylink; NULL thành undefined để JSON trả về giữ nguyên dạng cũ. */
function toPaylink(row: any): Paylink {
  const p: any = {};
  for (const [field, col] of Object.entries(COLUMNS)) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    p[field] = v instanceof Date ? v.toISOString() : v;
  }
  return p as Paylink;
}

export async function create(input: Pick<Paylink, 'amount' | 'currency' | 'description' | 'reference' | 'expiresAt' | 'nasStoreId' | 'bookingId' | 'callbackUrl'>): Promise<Paylink> {
  const id = `pl_${crypto.randomBytes(9).toString('base64url')}`;
  const { rows } = await pool.query(
    `INSERT INTO paylinks (id, amount, currency, description, reference, nas_store_id, booking_id, status, expires_at, callback_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9) RETURNING *`,
    [id, input.amount, input.currency, input.description, input.reference ?? null, input.nasStoreId ?? null,
     input.bookingId ?? null, input.expiresAt ?? null, input.callbackUrl ?? null],
  );
  return toPaylink(rows[0]);
}

export async function get(id: string): Promise<Paylink | undefined> {
  const { rows } = await pool.query('SELECT * FROM paylinks WHERE id = $1', [id]);
  return rows[0] ? toPaylink(rows[0]) : undefined;
}

export async function list(): Promise<Paylink[]> {
  const { rows } = await pool.query('SELECT * FROM paylinks ORDER BY created_at DESC');
  return rows.map(toPaylink);
}

/** Cập nhật các field có trong patch; giá trị undefined = xoá (NULL). */
export async function update(id: string, patch: Partial<Paylink>): Promise<Paylink> {
  const fields = (Object.keys(patch) as (keyof Paylink)[]).filter((k) => k !== 'id' && COLUMNS[k]);
  if (!fields.length) {
    const p = await get(id);
    if (!p) throw new Error(`Paylink ${id} does not exist`);
    return p;
  }
  const sets = fields.map((k, i) => `${COLUMNS[k]} = $${i + 2}`).join(', ');
  const values = fields.map((k) => patch[k] ?? null);
  const { rows } = await pool.query(`UPDATE paylinks SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
  if (!rows[0]) throw new Error(`Paylink ${id} does not exist`);
  return toPaylink(rows[0]);
}

/** Tăng attempts nguyên tử (an toàn khi nhiều request/instance), trả về số lần thử mới. */
export async function nextAttempt(id: string): Promise<number> {
  const { rows } = await pool.query('UPDATE paylinks SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [id]);
  if (!rows[0]) throw new Error(`Paylink ${id} does not exist`);
  return rows[0].attempts;
}

export function isExpired(p: Paylink): boolean {
  return !!p.expiresAt && new Date(p.expiresAt).getTime() < Date.now();
}
