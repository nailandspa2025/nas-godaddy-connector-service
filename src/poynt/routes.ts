/**
 * API admin (server-to-server, cần x-api-key) gọi trực tiếp Poynt theo tài liệu
 * "ISV integration with Poynt Cloud app and Poynt Collect":
 * business/ACH, store/device, Apple Pay, tokenize (Card on File), charge token, surcharge.
 * Merchant: ?nasStoreId= (query hoặc body) → cấu hình từ nas-catalog-api; không truyền → .env.
 */
import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { config } from '../config';
import { getPoyntMerchant } from '../catalog/client';
import {
  charge,
  ChargeRequest,
  envMerchant,
  getApplePayDomainAssociationFile,
  getBusiness,
  getEligibleFees,
  getStores,
  isAchAllowed,
  Merchant,
  tokenizeNonce,
  updateApplePayRegistration,
} from './service';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (config.adminApiKey && req.get('x-api-key') !== config.adminApiKey) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key' });
  }
  next();
}

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

async function merchantOf(req: Request): Promise<Merchant> {
  const raw = req.body?.nasStoreId ?? req.query.nasStoreId;
  if (raw === undefined || raw === '') return envMerchant();
  const nasStoreId = Number(raw);
  if (!Number.isInteger(nasStoreId) || nasStoreId <= 0) throw bad('nasStoreId must be a positive integer');
  return getPoyntMerchant(nasStoreId);
}

/** Bọc handler async để lỗi đi vào global error handler. */
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

const ACTIONS = ['SALE', 'AUTHORIZE'];
const INTENTS = ['UNSCHEDULED_COF_TXN', 'RECURRING_COF_TXN'];

/** Đọc + validate body chung cho charge / eligible-fees. */
function parseTransaction(body: any): Omit<ChargeRequest, 'requestId'> {
  const { nonce, cardToken, amount, currency = config.poynt.currency, action, intent, mit, transactionFees,
    shippingAddress, receiptEmailAddress, notes } = body || {};
  if (!Number.isInteger(amount) || amount <= 0) throw bad('amount must be a positive integer (cents)');
  if (!nonce === !cardToken) throw bad('Exactly one of nonce or cardToken is required');
  if (action !== undefined && !ACTIONS.includes(action)) throw bad(`action must be one of ${ACTIONS.join(', ')}`);
  if (intent !== undefined && !INTENTS.includes(intent)) throw bad(`intent must be one of ${INTENTS.join(', ')}`);
  if (mit !== undefined && typeof mit !== 'boolean') throw bad('mit must be a boolean');
  if (intent === 'RECURRING_COF_TXN' && mit === false) throw bad('mit must be true for RECURRING_COF_TXN');
  if (transactionFees !== undefined &&
      (!Array.isArray(transactionFees) || transactionFees.some((f: any) => !Number.isInteger(f?.amount) || f.amount < 0))) {
    throw bad('transactionFees must be an array of fees from eligible-fees (integer amount in cents)');
  }
  if (shippingAddress !== undefined && (typeof shippingAddress !== 'object' || shippingAddress === null)) {
    throw bad('shippingAddress must be an object');
  }
  return {
    nonce: nonce || undefined,
    cardToken: cardToken || undefined,
    amount,
    currency,
    action,
    intent,
    mit: intent === 'RECURRING_COF_TXN' ? true : mit,
    transactionFees,
    shippingAddress,
    receiptEmailAddress: receiptEmailAddress || undefined,
    notes: notes ? String(notes) : undefined,
  };
}

export const poyntRouter = Router();
poyntRouter.use(requireAdmin);

/** Thông tin business + cờ ACH (attributes.allowACH = "1"). */
poyntRouter.get('/business', h(async (req, res) => {
  const m = await merchantOf(req);
  res.json(await getBusiness(m));
}));

poyntRouter.get('/ach', h(async (req, res) => {
  const m = await merchantOf(req);
  res.json({ businessId: m.businessId, allowAch: await isAchAllowed(m) });
}));

/** Store + storeDevices (StoreId/DeviceId) của business. */
poyntRouter.get('/stores', h(async (req, res) => {
  res.json(await getStores(await merchantOf(req)));
}));

/** Đăng ký / huỷ domain Apple Pay: { registerDomains, unregisterDomains, merchantName, merchantUrl } */
poyntRouter.post('/apple-pay/registration', h(async (req, res) => {
  const { registerDomains = [], unregisterDomains = [], merchantName, merchantUrl } = req.body || {};
  const isDomainList = (v: unknown) => Array.isArray(v) && v.every((d) => typeof d === 'string' && d.trim());
  if (!isDomainList(registerDomains) || !isDomainList(unregisterDomains)) {
    throw bad('registerDomains and unregisterDomains must be arrays of domain names');
  }
  if (!registerDomains.length && !unregisterDomains.length) throw bad('registerDomains or unregisterDomains is required');
  if (registerDomains.length && !merchantName) throw bad('merchantName is required when registering domains');
  const m = await merchantOf(req);
  res.json(await updateApplePayRegistration(m, { registerDomains, unregisterDomains, merchantName, merchantUrl }));
}));

/**
 * Nội dung file association Apple Pay; host tại
 * https://{domain}/.well-known/apple-developer-merchantid-domain-association
 */
poyntRouter.get('/apple-pay/domain-association-file', h(async (req, res) => {
  const data = await getApplePayDomainAssociationFile(await merchantOf(req));
  if (typeof data === 'string') res.type('text/plain').send(data);
  else res.json(data);
}));

/** Đổi nonce lấy payment token; Card on File: { nonce, saveCardOnFile: true, cardAgreement } */
poyntRouter.post('/tokens', h(async (req, res) => {
  const { nonce, saveCardOnFile, cardAgreement, requestId } = req.body || {};
  if (!nonce) throw bad('nonce is required');
  if (saveCardOnFile !== undefined && typeof saveCardOnFile !== 'boolean') throw bad('saveCardOnFile must be a boolean');
  if (saveCardOnFile && (typeof cardAgreement !== 'object' || cardAgreement === null)) {
    throw bad('cardAgreement (from the Poynt Collect nonce response) is required when saveCardOnFile is true');
  }
  const m = await merchantOf(req);
  res.status(201).json(await tokenizeNonce(m, { nonce, saveCardOnFile, cardAgreement, requestId }));
}));

/** Kiểm tra surcharge: { nonce | cardToken, amount, ... } → { fees: [...] } */
poyntRouter.post('/eligible-fees', h(async (req, res) => {
  const input = parseTransaction(req.body);
  const m = await merchantOf(req);
  res.json(await getEligibleFees(m, input));
}));

/**
 * Charge: { nonce | cardToken, amount, action?, intent?, mit?, transactionFees?, requestId? }.
 * requestId (Poynt-Request-Id) nên do bên gọi truyền và giữ nguyên khi retry để Poynt không charge trùng.
 */
poyntRouter.post('/charges', h(async (req, res) => {
  const input = parseTransaction(req.body);
  const requestId = req.body?.requestId ? String(req.body.requestId) : crypto.randomUUID();
  const m = await merchantOf(req);
  const txn: any = await charge(m, { ...input, requestId });
  const approved = ['CAPTURED', 'AUTHORIZED'].includes(txn?.status);
  res.status(approved ? 200 : 402).json({ approved, requestId, transaction: txn });
}));
