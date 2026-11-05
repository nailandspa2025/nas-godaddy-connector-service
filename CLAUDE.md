# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small Express 5 + TypeScript API that creates **paylinks** (payment links) and charges them through **GoDaddy Payments (Poynt)** for the NAS platform. It serves no UI: the payment page lives in nas-portal (`/pay/:id`), which loads Poynt Collect, gets a card nonce, and sends it here. Code comments and the README are in Vietnamese.

## Commands

```bash
npm run dev        # tsx watch src/server.ts (default port 6009; README mentions 3100 from older config)
npm run build      # tsc → dist/
npm start          # node dist/server.js
npm run typecheck  # tsc --noEmit
npm run token      # scripts/token.ts: fetch a Poynt access token and list stores/devices for POYNT_BUSINESS_ID
```

The repo has no test suite and no linter. To check a change, run `npm run typecheck` and call the endpoints (curl examples in README.md; Postman collection in `postman/`).

## Configuration

`src/config.ts` loads `.env.${NODE_ENV || 'development'}` first, then `.env` as a fallback. Variables already set in the environment (e.g. `docker --env-file`) always win. `.env.development` and `.env.production` are committed (no secrets in `.env.production`). There is no `.env.example`, even though the README mentions one. The Poynt private key comes from `POYNT_PRIVATE_KEY` (inline, `\n`-escaped) or the PEM file at `POYNT_PRIVATE_KEY_PATH` (default `./keys/private.pem`). `assertConfig()` only logs a warning about missing config; it does not exit.

On startup, `initDb()` creates the Postgres database named in `DATABASE_URL` if it is missing (error 3D000) and runs idempotent `CREATE TABLE IF NOT EXISTS` for `paylinks` and `terminal_payments`. If the table is empty, it also imports the legacy `PAYLINK_DATA_FILE` JSON once. There is no migration tool, so schema changes go into the `SCHEMA` string in `src/db.ts` and must stay idempotent. Existing deployments also need a manual `ALTER`.

## Architecture

Request flow: `server.ts` → `paylink/routes.ts` → `catalog/client.ts` (which Poynt merchant) → `poynt/service.ts` → `poynt/client.ts` → `poynt/auth.ts`.

- **Paths**: every route is registered with the `/api/v1/...` prefix directly in `server.ts` (the old middleware that rewrote `/api/v{n}` to `/api` is commented out, so plain `/api/...` returns 404). The gateway maps `/godaddy/api/v1/...` to `/api/v1/...`.
- **Routers** (all mounted under `/api/v1/...` in `server.ts`):
  - `adminRouter` at `/api/v1/paylinks` is server-to-server and requires the `x-api-key` header when `ADMIN_API_KEY` is set. `/api/v1/stores` checks the same key inline.
  - `publicRouter` at `/api/v1/pay` is called from the browser, has CORS limited to `CORS_ORIGINS`, and needs no auth. Set `CORS_ORIGINS` to empty when running behind nas-gateway-api, because the gateway adds its own CORS headers.
  - `poyntRouter` (`src/poynt/routes.ts`) at `/api/v1/poynt` is a thin server-to-server wrapper over the Poynt APIs from the ISV integration PDF (business/ACH, stores, Apple Pay registration and association file, tokenize/Card on File, charge by nonce or `cardToken`, surcharge eligible-fees). It uses the same `x-api-key` check (`requireAdmin`), resolves the merchant from `nasStoreId` (query or body) or env, and stores nothing.
  - `terminalRouter` (`src/terminal/routes.ts`) at `/api/v1/terminal` handles card-present payments on Poynt Smart Terminals via the Payment Bridge API (`POST /cloudMessages`). Rows live in `terminal_payments` (one row per operation; the row id is the `referenceId` sent to the device). `terminalCallbackRouter` at `/api/v1/terminal/callback/:id` is called **by the terminal**, is mounted before the admin router, authenticates with a per-payment `X-Terminal-Secret` header, answers 200 immediately (terminal waits only 3s), then verifies via `GET /businesses/{id}/transactions/{txnId}` (referenceId, amount, device) before `store.complete()` atomically moves `PENDING` to a final status. The callback URL is built from `PUBLIC_BASE_URL`, which must be publicly reachable. A payment the terminal never acknowledges (no `terminalStatus`/`transactionId`) becomes `EXPIRED` once `expires_at` (now + `ttl`) plus 30s has passed. A 30s sweep in `server.ts` does this, and the GET routes also check on read. A late callback that carries a verified transaction can still move it from `EXPIRED` to a final status.
- **Merchant resolution (multi-store)**: a paylink with `nasStoreId` gets its Poynt `BusinessId`/`StoreId`/`DeviceId` from nas-catalog-api (`GET {CATALOG_API_URL}/api/v1/stores/payment-provider?paymentMethod=10`, cached in memory for 5 minutes). A paylink without one uses `POYNT_BUSINESS_ID`/`POYNT_STORE_ID`/`POYNT_DEVICE_ID` from env (`envMerchant()`). `resolveContext()` requires both StoreId and DeviceId and does **not** auto-discover them from Poynt; the README's claim that it does is outdated. Creating a paylink validates this context first, so a link is never issued for a misconfigured store.
- **Poynt auth**: the app signs an RS256 JWT with its private key and exchanges it at `POST /token`. The access token is cached in memory and refreshed 5 minutes before expiry, with concurrent refreshes deduplicated. `poynt/client.ts` retries once on 401 with a forced refresh. Errors are thrown as `PoyntError`; the global error handler maps Poynt 5xx to 502 and passes other statuses through.
- **Charging** (`POST /api/v1/pay/:id/pay`):
  - The amount always comes from the stored paylink, never from the client.
  - An in-process `charging` Set rejects concurrent charges for the same link. It is per-instance only.
  - Each attempt increments `attempts` atomically in the DB, and `Poynt-Request-Id` is `${id}-${attempt}`, which lets Poynt deduplicate retries.
  - Poynt status `CAPTURED` or `AUTHORIZED` marks the paylink `PAID`.
- **Callbacks** (`paylink/callback.ts`): once a link is `PAID`, the service sends `POST {callbackUrl}` with only `{ paylinkId }`, in the background. Retries run at 0s/5s/30s/2m, and the result is saved in `callbackStatus`/`callbackError`. A 200 response with `{ succeeded: false }` (the nas-order-api convention) counts as a failure. Receivers must re-fetch `GET /api/v1/paylinks/:id` to verify. A callback can be re-sent manually with `POST /api/v1/paylinks/:id/callback`.
- **Errors**: the codebase throws plain errors with `Object.assign(new Error(msg), { status, details })` instead of custom error classes, and the global handler turns them into the response.
- **Status model**: the DB stores `ACTIVE | PAID | CANCELLED`. `EXPIRED` is computed from `expiresAt` when building the public GET response and is never stored. Amounts are integer **cents**.
- **Persistence**: `paylink/store.ts` maps camelCase fields to snake_case columns through the `COLUMNS` map. A new field must be added to the `Paylink` type, `COLUMNS`, and `SCHEMA`. In `update()`, a patch value of `undefined` sets the column to NULL.

## Deployment

Every push to `main` triggers `.github/workflows/deploy.yml`. It builds the Docker image, pushes it to GHCR, then SSHes to a GCP host and restarts the container `nas-godaddy-connector-service` on Docker network `nas-net`, port 6009. The Dockerfile bakes in only the non-secret `.env.production` (`NODE_ENV=production`, Poynt **production**). Secrets come from GitHub Secrets at deploy time: `CONNECTOR_ENV` (POYNT_APPLICATION_ID, ADMIN_API_KEY, DATABASE_URL) is written to `~/nas/godaddy-connector/.env` and passed with `--env-file`; `POYNT_PRIVATE_KEY_PEM` is written to `~/nas/godaddy-connector/keys/private.pem` and mounted read-only. The deploy aborts before touching the running container if any is missing. `ADMIN_API_KEY` must equal nas-order-api's `PAYLINK_API_KEY` secret (`PaylinkSettings__ApiKey`); set both with `scripts/set-prod-secrets.sh`, which deploys order first. `keys/` and `.secrets/` are gitignored. Inside `nas-net`, Postgres is reachable as `postgres_db`. Poynt has two environments: OTE (`services-ote.poynt.net`) and production (`services.poynt.net`); the matching Collect SDK URLs are in README.md.
