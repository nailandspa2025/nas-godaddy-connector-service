# nas-paylink

Service tạo **link thanh toán (paylink)** cho app Poynt Cloud **NAS POS CRM**
(`urn:aid:d9601f4a-370a-4e41-9cba-075a39205640`, môi trường OTE).

Chỉ là API — trang thanh toán nằm ở nas-portal (`/pay/:id`).

Luồng: merchant tạo paylink → gửi link `{PAYMENT_PAGE_URL}/:id` (portal) cho khách → khách nhập thẻ vào form
Poynt Collect → server charge nonce qua `POST /businesses/{businessId}/cards/tokenize/charge`
với số tiền lưu trong paylink (không lấy số tiền từ client).

## Cài đặt

```bash
npm install
cp .env.example .env        # điền POYNT_BUSINESS_ID (+ storeId/deviceId nếu muốn)
# đặt private key của app vào ./keys/private.pem
# DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/Nas-GoDaddy  (database + bảng tự tạo khi start)
npm run token               # kiểm tra: lấy access token + liệt kê store/device
npm run dev                 # http://localhost:3100
```

Yêu cầu Node >= 18. Business phải đã cấp quyền (OAuth) cho app trong Developer Center.

## API

Số tiền tính bằng **cents** (`1050` = $10.50). Các API `/api/paylinks*` cần header
`x-api-key: $ADMIN_API_KEY` nếu có cấu hình.

```bash
# Tạo paylink
curl -X POST localhost:3100/api/paylinks -H 'Content-Type: application/json' \
  -d '{"amount":1050,"description":"Mani + Pedi","reference":"ORDER-123","expiresAt":"2026-12-31T00:00:00Z"}'
# → { "id": "pl_xxx", "url": "http://localhost:3100/pay/pl_xxx", "status": "ACTIVE", ... }

curl localhost:3100/api/paylinks             # danh sách
curl localhost:3100/api/paylinks/pl_xxx      # chi tiết (status, transactionId)
curl -X POST localhost:3100/api/paylinks/pl_xxx/cancel
curl localhost:3100/api/admin/stores         # store/device của business
```

Đa store (NAS): truyền `nasStoreId` khi tạo paylink → cấu hình Poynt (BusinessId/StoreId/DeviceId)
lấy từ nas-catalog-api (`CATALOG_API_URL`). Không truyền thì dùng `POYNT_BUSINESS_ID`… trong `.env`.

Callback: truyền `callbackUrl` khi tạo paylink → khi paylink `PAID`, server `POST {callbackUrl}`
body `{ "paylinkId": "pl_xxx" }` (thử lại 4 lần: 0s/5s/30s/2m). Bên nhận phải tự `GET /api/paylinks/:id`
để xác minh. Gửi lại thủ công: `POST /api/paylinks/:id/callback`. nas-order-api dùng
`POST /api/v1/payments/poynt-callback`.

Public (trang thanh toán trên nas-portal gọi, có CORS theo `CORS_ORIGINS`):
- `GET /api/pay/:id` — thông tin hiển thị + cấu hình Poynt Collect
- `POST /api/pay/:id/pay` `{ nonce, email? }` — charge `SALE`; thành công khi status `CAPTURED`/`AUTHORIZED`, paylink chuyển `PAID`

## Cấu trúc

```
src/config.ts           đọc .env + private key
src/poynt/auth.ts       self-signed JWT (RS256) → POST /token, cache token
src/poynt/client.ts     HTTP client, retry 1 lần khi 401
src/poynt/service.ts    resolve store/device, charge nonce
src/db.ts               kết nối PostgreSQL (DATABASE_URL), tự tạo database + bảng paylinks
src/paylink/store.ts    lưu paylink vào PostgreSQL (bảng paylinks)
src/paylink/routes.ts   API admin + public
scripts/token.ts        kiểm tra cấu hình
```

## Môi trường

| | API | Poynt Collect SDK |
|---|---|---|
| OTE | `https://services-ote.poynt.net` | `https://collect.commerce.ote-godaddy.com/sdk.js` |
| Production | `https://services.poynt.net` | `https://collect.commerce.godaddy.com/sdk.js` |

## Production checklist

- `DATABASE_URL` trỏ tới Postgres (trên server: `postgresql://postgres:<pw>@postgres_db:5432/Nas-GoDaddy`, network `nas-net`).
  Lần start đầu, nếu bảng `paylinks` trống mà có `PAYLINK_DATA_FILE` (data/paylinks.json cũ) thì dữ liệu được import một lần.
- Bật `ADMIN_API_KEY`, chạy sau HTTPS. Đặt `PAYMENT_PAGE_URL` = `https://<portal>/pay` và `CORS_ORIGINS` = domain portal.
- Thêm webhook Poynt (`TRANSACTION_*`) để đối soát trạng thái thay vì chỉ dựa vào response charge.
- Không commit `.env` và `keys/`.
