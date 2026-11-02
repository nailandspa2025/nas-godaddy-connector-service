/**
 * Kết nối PostgreSQL (DATABASE_URL). Khi khởi động:
 *  - tạo database nếu chưa có (giống các service NAS khác: mỗi service một DB trên postgres_db),
 *  - tạo bảng paylinks nếu chưa có,
 *  - import một lần data/paylinks.json cũ (nếu bảng đang trống).
 */
import fs from 'fs';
import { Client, Pool } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (e) => console.error('[db] idle client error', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS paylinks (
  id               TEXT PRIMARY KEY,
  amount           INTEGER NOT NULL CHECK (amount > 0),
  currency         TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  reference        TEXT,
  nas_store_id     INTEGER,
  status           TEXT NOT NULL CHECK (status IN ('ACTIVE','PAID','CANCELLED')),
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at          TIMESTAMPTZ,
  transaction_id   TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  callback_url     TEXT,
  callback_status  TEXT CHECK (callback_status IN ('DONE','FAILED')),
  callback_error   TEXT
);
CREATE INDEX IF NOT EXISTS paylinks_created_at_idx ON paylinks (created_at DESC);
CREATE INDEX IF NOT EXISTS paylinks_reference_idx ON paylinks (reference);

-- Thanh toán trên máy POS (Payment Bridge / cloudMessages). Mỗi thao tác (sale, authorize, capture, void, refund)
-- là một dòng; id cũng là referenceId gửi xuống máy. capture/void/refund trỏ về giao dịch gốc qua parent_id.
CREATE TABLE IF NOT EXISTS terminal_payments (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT UNIQUE,
  parent_id           TEXT REFERENCES terminal_payments(id),
  action              TEXT NOT NULL CHECK (action IN ('SALE','AUTHORIZE','CAPTURE','VOID','REFUND')),
  amount              INTEGER CHECK (amount > 0),
  currency            TEXT NOT NULL,
  reference           TEXT,
  notes               TEXT,
  nas_store_id        INTEGER,
  business_id         TEXT NOT NULL,
  store_id            TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','DECLINED','CANCELLED','FAILED')),
  terminal_status     TEXT,
  transaction_id      TEXT,
  transaction_status  TEXT,
  card_type           TEXT,
  card_last4          TEXT,
  error               TEXT,
  callback_secret     TEXT NOT NULL,
  callback_url        TEXT,
  callback_status     TEXT CHECK (callback_status IN ('DONE','FAILED')),
  callback_error      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS terminal_payments_created_at_idx ON terminal_payments (created_at DESC);
CREATE INDEX IF NOT EXISTS terminal_payments_reference_idx ON terminal_payments (reference);
CREATE INDEX IF NOT EXISTS terminal_payments_device_status_idx ON terminal_payments (device_id, status);
`;

/** Tạo database trong DATABASE_URL nếu chưa tồn tại (lỗi 3D000). */
async function ensureDatabase(): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (e: any) {
    if (e.code !== '3D000') throw e;
    const url = new URL(config.databaseUrl);
    const dbName = decodeURIComponent(url.pathname.slice(1));
    url.pathname = '/postgres';
    const admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[db] created database ${dbName}`);
    } finally {
      await admin.end();
    }
  }
}

/** Chuyển dữ liệu từ file JSON cũ sang DB, chỉ khi bảng còn trống. */
async function importLegacyJson(): Promise<void> {
  if (!fs.existsSync(config.dataFile)) return;
  const { rows } = await pool.query('SELECT 1 FROM paylinks LIMIT 1');
  if (rows.length) return;
  const all: Record<string, any> = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
  const items = Object.values(all);
  if (!items.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of items) {
      await client.query(
        `INSERT INTO paylinks (id, amount, currency, description, reference, nas_store_id, status, expires_at,
           created_at, paid_at, transaction_id, attempts, callback_url, callback_status, callback_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
        [p.id, p.amount, p.currency, p.description ?? '', p.reference ?? null, p.nasStoreId ?? null, p.status,
         p.expiresAt ?? null, p.createdAt, p.paidAt ?? null, p.transactionId ?? null, p.attempts ?? 0,
         p.callbackUrl ?? null, p.callbackStatus ?? null, p.callbackError ?? null],
      );
    }
    await client.query('COMMIT');
    console.log(`[db] imported ${items.length} paylinks from ${config.dataFile}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function initDb(): Promise<void> {
  if (!config.databaseUrl) throw new Error('Missing DATABASE_URL (vd postgresql://postgres:***@postgres_db:5432/Nas-GoDaddy)');
  await ensureDatabase();
  await pool.query(SCHEMA);
  await importLegacyJson();
  console.log('[db] PostgreSQL ready');
}
