/** Lưu giao dịch máy POS trong PostgreSQL (bảng terminal_payments, xem src/db.ts). */
import crypto from 'crypto';
import { pool } from '../db';

export type TerminalAction = 'SALE' | 'AUTHORIZE' | 'CAPTURE' | 'VOID' | 'REFUND';
export type TerminalStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'FAILED' | 'EXPIRED';

export type TerminalPayment = {
  id: string; // cũng là referenceId gửi xuống máy POS
  requestId?: string; // khoá idempotency do bên gọi truyền
  parentId?: string; // giao dịch gốc của capture/void/refund
  action: TerminalAction;
  amount?: number; // cents; capture/void/refund toàn phần thì không có
  currency: string;
  reference?: string;
  notes?: string;
  nasStoreId?: number;
  businessId: string;
  storeId: string;
  deviceId: string;
  status: TerminalStatus;
  terminalStatus?: string; // RECEIVED / STARTED / PROCESSED / CANCELED do máy POS báo
  transactionId?: string;
  transactionStatus?: string;
  cardType?: string;
  cardLast4?: string;
  error?: string;
  callbackSecret: string;
  callbackUrl?: string; // POST { terminalPaymentId } khi có kết quả cuối
  callbackStatus?: 'DONE' | 'FAILED';
  callbackError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  expiresAt?: string; // hết hạn giao lệnh xuống máy (createdAt + ttl)
};

const COLUMNS: Record<keyof TerminalPayment, string> = {
  id: 'id',
  requestId: 'request_id',
  parentId: 'parent_id',
  action: 'action',
  amount: 'amount',
  currency: 'currency',
  reference: 'reference',
  notes: 'notes',
  nasStoreId: 'nas_store_id',
  businessId: 'business_id',
  storeId: 'store_id',
  deviceId: 'device_id',
  status: 'status',
  terminalStatus: 'terminal_status',
  transactionId: 'transaction_id',
  transactionStatus: 'transaction_status',
  cardType: 'card_type',
  cardLast4: 'card_last4',
  error: 'error',
  callbackSecret: 'callback_secret',
  callbackUrl: 'callback_url',
  callbackStatus: 'callback_status',
  callbackError: 'callback_error',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  completedAt: 'completed_at',
  expiresAt: 'expires_at',
};

function toPayment(row: any): TerminalPayment {
  const p: any = {};
  for (const [field, col] of Object.entries(COLUMNS)) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    p[field] = v instanceof Date ? v.toISOString() : v;
  }
  return p as TerminalPayment;
}

/** Bỏ secret trước khi trả ra API. */
export function publicView(p: TerminalPayment): Omit<TerminalPayment, 'callbackSecret'> {
  const { callbackSecret: _secret, ...rest } = p;
  return rest;
}

export type CreateInput = Pick<TerminalPayment, 'action' | 'currency' | 'businessId' | 'storeId' | 'deviceId'> &
  Partial<Pick<TerminalPayment, 'requestId' | 'parentId' | 'amount' | 'reference' | 'notes' | 'nasStoreId' | 'callbackUrl'>> & {
    ttl: number; // giây; expires_at = now() + ttl
  };

export async function create(input: CreateInput): Promise<TerminalPayment> {
  const id = `tp_${crypto.randomBytes(9).toString('base64url')}`;
  const secret = crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query(
    `INSERT INTO terminal_payments (id, request_id, parent_id, action, amount, currency, reference, notes, nas_store_id,
       business_id, store_id, device_id, status, callback_secret, callback_url, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING',$13,$14, now() + make_interval(secs => $15)) RETURNING *`,
    [id, input.requestId ?? null, input.parentId ?? null, input.action, input.amount ?? null, input.currency,
     input.reference ?? null, input.notes ?? null, input.nasStoreId ?? null, input.businessId, input.storeId,
     input.deviceId, secret, input.callbackUrl ?? null, input.ttl],
  );
  return toPayment(rows[0]);
}

export async function get(id: string): Promise<TerminalPayment | undefined> {
  const { rows } = await pool.query('SELECT * FROM terminal_payments WHERE id = $1', [id]);
  return rows[0] ? toPayment(rows[0]) : undefined;
}

export async function getByRequestId(requestId: string): Promise<TerminalPayment | undefined> {
  const { rows } = await pool.query('SELECT * FROM terminal_payments WHERE request_id = $1', [requestId]);
  return rows[0] ? toPayment(rows[0]) : undefined;
}

export async function list(filter: { reference?: string; parentId?: string } = {}): Promise<TerminalPayment[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.reference) { values.push(filter.reference); where.push(`reference = $${values.length}`); }
  if (filter.parentId) { values.push(filter.parentId); where.push(`parent_id = $${values.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM terminal_payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`,
    values,
  );
  return rows.map(toPayment);
}

/** Giao dịch sale/authorize còn PENDING trên máy này trong `withinMinutes` phút gần nhất. */
export async function findPendingOnDevice(deviceId: string, withinMinutes: number): Promise<TerminalPayment | undefined> {
  const { rows } = await pool.query(
    `SELECT * FROM terminal_payments
     WHERE device_id = $1 AND status = 'PENDING' AND action IN ('SALE','AUTHORIZE')
       AND created_at > now() - make_interval(mins => $2)
     ORDER BY created_at DESC LIMIT 1`,
    [deviceId, withinMinutes],
  );
  return rows[0] ? toPayment(rows[0]) : undefined;
}

/** Cập nhật field trong patch (undefined = NULL), luôn đổi updated_at. */
export async function update(id: string, patch: Partial<TerminalPayment>): Promise<TerminalPayment> {
  const fields = (Object.keys(patch) as (keyof TerminalPayment)[])
    .filter((k) => !['id', 'createdAt', 'updatedAt'].includes(k) && COLUMNS[k]);
  const sets = [...fields.map((k, i) => `${COLUMNS[k]} = $${i + 2}`), 'updated_at = now()'].join(', ');
  const values = fields.map((k) => patch[k] ?? null);
  const { rows } = await pool.query(`UPDATE terminal_payments SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
  if (!rows[0]) throw new Error(`Terminal payment ${id} does not exist`);
  return toPayment(rows[0]);
}

/**
 * Chuyển PENDING → trạng thái cuối, nguyên tử: chỉ một callback (hoặc sync) thắng.
 * Trả undefined nếu giao dịch đã có trạng thái cuối trước đó.
 * `fromExpired`: cho phép chốt cả giao dịch đã EXPIRED (máy báo kết quả muộn — tiền đã bị trừ thì phải ghi nhận).
 */
export async function complete(
  id: string,
  patch: Partial<TerminalPayment> & { status: TerminalStatus },
  opts: { fromExpired?: boolean } = {},
): Promise<TerminalPayment | undefined> {
  const fields = (Object.keys(patch) as (keyof TerminalPayment)[])
    .filter((k) => !['id', 'createdAt', 'updatedAt', 'completedAt'].includes(k) && COLUMNS[k]);
  const sets = [...fields.map((k, i) => `${COLUMNS[k]} = $${i + 2}`), 'updated_at = now()', 'completed_at = now()'].join(', ');
  const values = fields.map((k) => patch[k] ?? null);
  const { rows } = await pool.query(
    `UPDATE terminal_payments SET ${sets} WHERE id = $1 AND status IN (${opts.fromExpired ? "'PENDING','EXPIRED'" : "'PENDING'"}) RETURNING *`,
    [id, ...values],
  );
  return rows[0] ? toPayment(rows[0]) : undefined;
}

/**
 * PENDING → EXPIRED cho giao dịch máy POS chưa hề phản hồi (không có terminalStatus/transactionId)
 * sau khi hết ttl + `graceSeconds`. Dòng cũ chưa có expires_at thì tính created_at + `defaultTtl`.
 * Giao dịch máy đã báo RECEIVED/STARTED (khách đang thao tác) thì không đụng tới.
 */
export async function expireStale(graceSeconds: number, defaultTtl: number, id?: string): Promise<TerminalPayment[]> {
  const { rows } = await pool.query(
    `UPDATE terminal_payments
     SET status = 'EXPIRED', error = 'Terminal did not respond before the request expired',
         updated_at = now(), completed_at = now()
     WHERE status = 'PENDING' AND terminal_status IS NULL AND transaction_id IS NULL
       AND COALESCE(expires_at, created_at + make_interval(secs => $2)) + make_interval(secs => $1) < now()
       AND ($3::text IS NULL OR id = $3)
     RETURNING *`,
    [graceSeconds, defaultTtl, id ?? null],
  );
  return rows.map(toPayment);
}
