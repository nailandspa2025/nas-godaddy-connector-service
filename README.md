# nas-paylink

Service tạo **link thanh toán (paylink)** cho app Poynt Cloud **NAS POS CRM**
(`urn:aid:d9601f4a-370a-4e41-9cba-075a39205640`, môi trường OTE).

Chỉ là API — trang thanh toán nằm ở nas-portal (`/pay/:id`).

Luồng: merchant tạo paylink → trả `id`, app/portal tự ghép link `{portal}/pay/:id` gửi cho khách → khách nhập thẻ vào form
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
# → { "id": "pl_xxx", "status": "ACTIVE", ... }  (link khách = {portal}/pay/pl_xxx)

curl localhost:3100/api/paylinks             # danh sách
curl localhost:3100/api/paylinks/pl_xxx      # chi tiết (status, transactionId)
curl -X POST localhost:3100/api/paylinks/pl_xxx/cancel
curl localhost:3100/api/stores         # store/device của business
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

`collect.paymentMethods` trong `GET /api/pay/:id` là `["card","ach"]` khi business có `attributes.allowACH = "1"`
(cache 5 phút), ngược lại `["card"]` — portal dùng làm `paymentMethods` khi `collect.mount(...)`.
Google Pay / Paze / Apple Pay bật phía portal qua `collect.supportWalletPayments()`.

### Poynt (admin, server-to-server)

Theo tài liệu *ISV integration with Poynt Cloud app and Poynt Collect*. Cần `x-api-key`.
Merchant: `nasStoreId` (query hoặc body) → cấu hình store NAS; không truyền → `.env`.

| API | Poynt |
|---|---|
| `GET /api/poynt/business` | `GET /businesses/{id}` |
| `GET /api/poynt/ach` → `{ allowAch }` | `attributes.allowACH` của business |
| `GET /api/poynt/stores` (= `/api/stores`) | `GET /businesses/{id}/stores` |
| `POST /api/poynt/apple-pay/registration` `{ registerDomains, unregisterDomains?, merchantName, merchantUrl? }` | `POST /businesses/{id}/apple-pay/registration` |
| `GET /api/poynt/apple-pay/domain-association-file` | nội dung file host tại `https://{domain}/.well-known/apple-developer-merchantid-domain-association` |
| `POST /api/poynt/tokens` `{ nonce, saveCardOnFile?, cardAgreement? }` | `POST /businesses/{id}/cards/tokenize` (Card on File) |
| `POST /api/poynt/eligible-fees` `{ nonce \| cardToken, amount }` | `POST /businesses/{id}/transactions/eligible-fees` (surcharge) |
| `POST /api/poynt/charges` `{ nonce \| cardToken, amount, action?, intent?, mit?, transactionFees?, requestId? }` | `POST /businesses/{id}/cards/tokenize/charge` |

- `charges`: `action` = `SALE` (mặc định) / `AUTHORIZE`; COF: `intent` = `UNSCHEDULED_COF_TXN` / `RECURRING_COF_TXN`
  (`RECURRING_COF_TXN` luôn gửi `mit: true`). Surcharge: truyền `fees` từ `eligible-fees` vào `transactionFees`,
  `amount` là tiền đơn hàng — server gửi `transactionAmount = amount + Σ fee.amount`, `orderAmount = amount`.
- Token tạo với `saveCardOnFile: true` **bắt buộc có `intent`** khi charge (kể cả `AUTHORIZE`), nếu thiếu Poynt trả
  400 `Invalid transaction intent provided`. Token thường (không COF) charge được không cần `intent` (đã test OTE).
- Truyền `requestId` cố định cho mỗi giao dịch và giữ nguyên khi retry (là `Poynt-Request-Id`) để Poynt không charge trùng:
  retry với **cùng body** → Poynt trả lại đúng transaction cũ; cùng `requestId` nhưng body khác → Poynt trả 400.
- Payment token (`cardToken`) do bên gọi lưu; service này không lưu token.

### Thanh toán trên máy POS (Payment Bridge)

Theo [Payment Bridge API](https://docs.poynt.com/app-integration/semiIntegration/payment-bridge/payment-actions.html):
server gửi lệnh qua `POST /cloudMessages` → Poynt cloud chuyển xuống Smart Terminal → khách quẹt/chạm thẻ →
**máy POS** POST kết quả về `{PUBLIC_BASE_URL}/api/v1/terminal/callback/:id` → server `GET` lại transaction từ Poynt để
xác minh → báo `callbackUrl` (nas-order-api) với body `{ "terminalPaymentId": "tp_xxx" }`, bên nhận tự `GET` lại để xác minh.

Yêu cầu: app có quyền **Cloud Messages – WRITE**; `PUBLIC_BASE_URL` là URL public mà máy POS gọi được
(vd `https://<gateway>/godaddy`, gateway map `/godaddy/api/v1/*` → `/api/v1/*`). Server cảnh báo khi đang là localhost.

Cấu hình máy POS theo store NAS lấy từ nas-catalog-api, phương thức **POS Payment** (`PaymentMethod.PosPayment = 11`,
settings `BusinessId`, `StoreId`, `DeviceId`), tách riêng với cấu hình Poynt (`= 10`) của paylink.

| API (cần `x-api-key`) | Mô tả |
|---|---|
| `GET /api/v1/terminal/devices?nasStoreId=` | Máy POS đã kích hoạt trong StoreId của store |
| `POST /api/v1/terminal/devices/pcm-profile` `{ nasStoreId?, deviceId? }` | Gửi `setCustomPcmProfile` (Poynt khuyến nghị, giữ kết nối máy ổn định) |
| `POST /api/v1/terminal/payments` `{ amount, action?: SALE\|AUTHORIZE, nasStoreId?, deviceId?, reference?, notes?, requestId?, callbackUrl?, allowTip?, ttl? }` | Gửi giao dịch xuống máy → 202 `PENDING` |
| `GET /api/v1/terminal/payments?reference=` | Danh sách |
| `GET /api/v1/terminal/payments/:id` | Chi tiết + `operations[]` (capture/void/refund) |
| `POST /api/v1/terminal/payments/:id/cancel` | Huỷ giao dịch đang chờ trên máy (kết quả về qua callback `CANCELED`) |
| `POST /api/v1/terminal/payments/:id/capture` / `void` / `refund` `{ amount? (chỉ refund), requestId? }` | Thao tác trên máy, tạo một giao dịch con |
| `POST /api/v1/terminal/payments/:id/sync` | Xác minh lại với Poynt khi còn `PENDING` nhưng máy đã báo transactionId |
| `POST /api/v1/terminal/payments/:id/callback` | Gửi lại callback cho nas-order-api |

- Trạng thái: `PENDING` → `APPROVED` / `DECLINED` / `CANCELLED` / `FAILED` (gửi lệnh lỗi hoặc xác minh không khớp) /
  `EXPIRED` (máy không phản hồi gì trong `ttl` + 30s: lệnh đã bị Poynt bỏ, máy không hiện giao dịch). Server quét mỗi 30s
  và báo `callbackUrl`. Giao dịch máy đã báo `RECEIVED`/`STARTED` thì không bị EXPIRED. Nếu sau đó máy vẫn báo về một
  transaction hợp lệ, giao dịch `EXPIRED` vẫn được chốt sang `APPROVED`/`DECLINED` (và callback lại).
  `terminalStatus` = trạng thái máy báo (`RECEIVED`, `STARTED`, `PROCESSED`, `CANCELED`).
- `deviceId` mặc định là DeviceId của store; phải là máy `TERMINAL` `ACTIVATED` trong đúng StoreId.
  Máy đang có sale/authorize `PENDING` (trong 10 phút) thì từ chối giao dịch mới (409) — huỷ hoặc chờ kết quả.
- `requestId` là khoá idempotency: gửi lại cùng `requestId` trả giao dịch cũ (200), không gửi lệnh mới xuống máy.
- Callback từ máy POS được xác thực bằng header `X-Terminal-Secret` riêng cho từng giao dịch (gửi qua `custom-http-header`);
  kết quả chỉ được chốt sau khi `GET /businesses/{id}/transactions/{txnId}` khớp referenceId, số tiền, device.
- `ttl` (mặc định 60s, lưu thành `expiresAt`) chỉ là thời gian Poynt giữ lệnh khi chưa giao được xuống máy, không phải thời gian chờ khách.
- Nếu máy không bao giờ gọi callback (mất mạng sau khi thanh toán), giao dịch giữ `PENDING`; kiểm tra trên máy/Poynt HQ.

## Cấu trúc

```
src/config.ts           đọc .env + private key
src/poynt/auth.ts       self-signed JWT (RS256) → POST /token, cache token
src/poynt/client.ts     HTTP client, retry 1 lần khi 401
src/poynt/service.ts    gọi Poynt: business/ACH, store, Apple Pay, tokenize, charge, eligible-fees
src/poynt/routes.ts     API admin /api/v1/poynt/*
src/terminal/           thanh toán trên máy POS (Payment Bridge): store, service (cloudMessages + xác minh callback), routes
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
- Bật `ADMIN_API_KEY`, chạy sau HTTPS. Đặt `CORS_ORIGINS` = domain portal (hoặc `*`).
- Thêm webhook Poynt (`TRANSACTION_*`) để đối soát trạng thái thay vì chỉ dựa vào response charge.
- Không commit `.env` và `keys/`.
