import express, { NextFunction, Request, Response } from 'express';
import { assertConfig, config } from './config';
import { adminRouter, publicRouter } from './paylink/routes';
import { getPoyntMerchant } from './catalog/client';
import { envMerchant, getStores } from './poynt/service';
import { PoyntError } from './poynt/client';

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

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof PoyntError ? (err.status >= 500 ? 502 : err.status) : err.status || 500;
  console.error('[error]', err.message, err.details ?? '');
  res.status(status).json({ error: err.message, details: err.details });
});

app.listen(config.port, () => console.log(`nas-paylink listening on ${config.publicBaseUrl}`));
