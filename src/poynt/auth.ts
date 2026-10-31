/**
 * Self-signed JWT (RS256, ký bằng private key của app) → POST /token (grantType jwt-bearer).
 * Access token được cache trong bộ nhớ và làm mới trước khi hết hạn 5 phút.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

const REFRESH_MARGIN_SEC = 300;
let cache = { accessToken: '', expiresAt: 0 };
let inflight: Promise<void> | null = null;

export function createSelfSignedJwt(): string {
  const { applicationId, privateKey, apiUrl } = config.poynt;
  if (!applicationId || !privateKey) throw new Error('POYNT_APPLICATION_ID or private key is not configured');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now, exp: now + 300, iss: applicationId, sub: applicationId, aud: apiUrl, jti: crypto.randomUUID() },
    privateKey,
    { algorithm: 'RS256' },
  );
}

async function requestToken(): Promise<void> {
  const res = await fetch(`${config.poynt.apiUrl}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'api-version': '1.2',
      'Poynt-Request-Id': crypto.randomUUID(),
    },
    body: new URLSearchParams({
      grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: createSelfSignedJwt(),
    }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw Object.assign(new Error(`Failed to get Poynt access token (${res.status})`), { status: res.status, details: data });
  }
  cache = {
    accessToken: data.accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + Number(data.expiresIn || 0),
  };
}

export async function getAccessToken({ force = false } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!force && cache.accessToken && cache.expiresAt - REFRESH_MARGIN_SEC > now) return cache.accessToken;
  if (!inflight) inflight = requestToken().finally(() => { inflight = null; });
  await inflight;
  return cache.accessToken;
}
