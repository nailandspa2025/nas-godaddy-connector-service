import fs from 'fs';
import path from 'path';
import 'dotenv/config';

function loadPrivateKey(): string | null {
  if (process.env.POYNT_PRIVATE_KEY) return process.env.POYNT_PRIVATE_KEY.replace(/\\n/g, '\n');
  const abs = path.resolve(process.cwd(), process.env.POYNT_PRIVATE_KEY_PATH || './keys/private.pem');
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

const port = Number(process.env.PORT) || 3000;

export const config = {
  port,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  adminApiKey: process.env.ADMIN_API_KEY || null,
  /** Trang thanh toán (UI nằm ở nas-portal), link khách mở = {paymentPageUrl}/{id} */
  paymentPageUrl: (process.env.PAYMENT_PAGE_URL || 'http://localhost:5173/pay').replace(/\/$/, ''),
  /** Origin được phép gọi /api/pay/* từ trình duyệt (nas-portal), phân tách bằng dấu phẩy */
  // Đặt CORS_ORIGINS= (rỗng) khi chạy sau nas-gateway-api: gateway đã thêm CORS, tránh trùng header
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** PostgreSQL, vd postgresql://postgres:***@postgres_db:5432/Nas-GoDaddy (postgres_db trên network nas-net) */
  databaseUrl: process.env.DATABASE_URL || '',
  /** File JSON cũ — chỉ dùng để import một lần vào DB khi bảng còn trống */
  dataFile: path.resolve(process.cwd(), process.env.PAYLINK_DATA_FILE || './data/paylinks.json'),
  /** nas-catalog-api: lấy cấu hình Poynt (BusinessId/StoreId/DeviceId) theo store NAS */
  catalogApiUrl: (process.env.CATALOG_API_URL || '').replace(/\/$/, ''),
  poynt: {
    apiUrl: (process.env.POYNT_API_URL || 'https://services-ote.poynt.net').replace(/\/$/, ''),
    collectSdkUrl: process.env.POYNT_COLLECT_SDK_URL || 'https://collect.commerce.ote-godaddy.com/sdk.js',
    applicationId: process.env.POYNT_APPLICATION_ID || '',
    privateKey: loadPrivateKey(),
    businessId: process.env.POYNT_BUSINESS_ID || '',
    storeId: process.env.POYNT_STORE_ID || null,
    deviceId: process.env.POYNT_DEVICE_ID || null,
    currency: process.env.DEFAULT_CURRENCY || 'USD',
  },
};

export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.poynt.applicationId) missing.push('POYNT_APPLICATION_ID');
  if (!config.poynt.privateKey) missing.push('POYNT_PRIVATE_KEY / POYNT_PRIVATE_KEY_PATH');
  if (!config.catalogApiUrl && !config.poynt.businessId) missing.push('CATALOG_API_URL hoặc POYNT_BUSINESS_ID');
  if (missing.length) console.warn(`[config] Missing configuration: ${missing.join(', ')} — Poynt API calls will fail.`);
}
