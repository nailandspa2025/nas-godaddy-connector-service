#!/usr/bin/env bash
# Đặt GitHub Secrets để chuyển nas-godaddy-connector-service sang Poynt PRODUCTION và bật ADMIN_API_KEY.
#
# Yêu cầu: gh auth login (quyền admin 2 repo), đã sửa .secrets/connector.prod.env (POYNT_APPLICATION_ID thật).
# Dùng:    bash scripts/set-prod-secrets.sh [đường-dẫn-private-key.pem]
#          (mặc định .secrets/poynt-prod-private.pem — cặp khoá đã sinh sẵn, public key: .secrets/poynt-prod-public.pem)
#
# Thứ tự an toàn:
#   1. nas-order-api nhận PAYLINK_API_KEY rồi redeploy → bắt đầu gửi header x-api-key
#      (connector hiện tại ADMIN_API_KEY rỗng nên bỏ qua header, không gián đoạn).
#   2. Sau khi order deploy xong mới push connector → connector bật kiểm tra key + chạy production.
set -euo pipefail
cd "$(dirname "$0")/.."

CONNECTOR_REPO=nailandspa2025/nas-godaddy-connector-service
ORDER_REPO=nailandspa2025/nas-order-api
ENV_FILE=.secrets/connector.prod.env
KEY_FILE=${1:-.secrets/poynt-prod-private.pem}
API_KEY_FILE=.secrets/paylink_api_key.txt

die() { echo "LỖI: $*" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || die "chưa đăng nhập: chạy gh auth login"
[ -f "$ENV_FILE" ] || die "thiếu $ENV_FILE"
grep -q '^POYNT_APPLICATION_ID=urn:aid:' "$ENV_FILE" || die "sửa POYNT_APPLICATION_ID trong $ENV_FILE thành app id production (urn:aid:...)"
grep -q '^DATABASE_URL=postgres' "$ENV_FILE" || die "$ENV_FILE thiếu DATABASE_URL"
grep -q 'BEGIN .*PRIVATE KEY' "$KEY_FILE" || die "$KEY_FILE không phải private key PEM"
[ -s "$API_KEY_FILE" ] || die "thiếu $API_KEY_FILE"
ADMIN_KEY=$(grep '^ADMIN_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
[ "$ADMIN_KEY" = "$(cat "$API_KEY_FILE")" ] || die "ADMIN_API_KEY trong $ENV_FILE khác $API_KEY_FILE"

echo "==> [1/3] nas-order-api: PAYLINK_API_KEY"
gh secret set PAYLINK_API_KEY -R "$ORDER_REPO" < "$API_KEY_FILE"

echo "==> [2/3] nas-godaddy-connector-service: CONNECTOR_ENV, POYNT_PRIVATE_KEY_PEM"
grep -v '^#' "$ENV_FILE" | grep -v '^[[:space:]]*$' | gh secret set CONNECTOR_ENV -R "$CONNECTOR_REPO"
gh secret set POYNT_PRIVATE_KEY_PEM -R "$CONNECTOR_REPO" < "$KEY_FILE"

echo "==> [3/3] Redeploy nas-order-api (workflow_dispatch) để nạp PAYLINK_API_KEY"
gh workflow run deploy.yml -R "$ORDER_REPO" --ref main
sleep 5
RUN_ID=$(gh run list -R "$ORDER_REPO" --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" -R "$ORDER_REPO" --exit-status

cat <<'EOF'

Xong secrets + order đã deploy.
Bước tiếp theo:
  1. git push nhánh main của nas-godaddy-connector-service (workflow tự deploy, tự kiểm tra secrets trước khi thay container).
  2. Kiểm tra:  curl -s -H "x-api-key: $(cat .secrets/paylink_api_key.txt)" \
                  "https://api.nasshine.com/godaddy/api/v1/terminal/devices?nasStoreId=1"
     → phải trả danh sách máy POS (không còn 401 UNAUTHORIZED_ACCESS).
EOF
