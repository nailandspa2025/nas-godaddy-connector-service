import express, { NextFunction, Request, Response } from 'express';
import { assertConfig, config } from './config';
import { adminRouter, publicRouter } from './paylink/routes';
import { getPoyntMerchant } from './catalog/client';
import { envMerchant, getStores } from './poynt/service';
import { PoyntError } from './poynt/client';
import { initDb, pool } from './db';

assertConfig();

const app = express();
app.use(express.json());

/** CORS chỉ cho API public mà trang thanh toán trên nas-portal gọi; API admin là server-to-server. */
function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('origin');
  if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

app.use('/api/paylinks', adminRouter);
app.use('/api/pay', cors, publicRouter);

app.get('/api/admin/stores', async (req, res, next) => {
  if (config.adminApiKey && req.get('x-api-key') !== config.adminApiKey) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // ?nasStoreId=123 → business của store NAS đó; không truyền → business trong .env
    const nasStoreId = Number(req.query.nasStoreId);
    const merchant = nasStoreId > 0 ? await getPoyntMerchant(nasStoreId) : envMerchant();
    res.json(await getStores(merchant));
  } catch (e) { next(e); }
});

// /api/health để gọi qua gateway (/godaddy/api/health → /api/health)
app.get(['/health', '/api/health'], async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (e: any) {
    res.status(503).json({ ok: false, db: 'down', error: e.message });
  }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof PoyntError ? (err.status >= 500 ? 502 : err.status) : err.status || 500;
  console.error('[error]', err.message, err.details ?? '');
  res.status(status).json({ error: err.message, details: err.details });
});

initDb()
  .then(() =>
    app.listen(config.port, (err?: Error) => {
      if (err) {
        console.error(`[server] cannot listen on port ${config.port}:`, err.message);
        process.exit(1);
      }
      console.log(`nas-godaddy-connector-service listening on port ${config.port} (public: ${config.publicBaseUrl})`);
    }),
  )
  .catch((e) => {
    console.error('[db] init failed:', e.message || e.code || e);
    process.exit(1);
  });
