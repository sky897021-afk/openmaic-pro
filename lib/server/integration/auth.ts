/**
 * Server-to-server authentication for the integration API.
 *
 * The platform's backend signs each request with a shared secret; the secret
 * never travels on the wire, and the browser never sees it. The signed string
 * is `${timestamp}.${nonce}.${rawBody}`, so a captured request cannot be
 * replayed with a different payload.
 *
 * The nonce cache is per-process and best-effort: it closes the replay window
 * for a single OpenMAIC instance. A multi-instance deployment would move this
 * to shared storage; the timestamp window still bounds a replay to five
 * minutes there.
 *
 * This module is server-only. It is reached exclusively from the integration
 * routes.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { NextRequest } from 'next/server';

import { buildRequestOrigin } from '@/lib/server/classroom-storage';

const TIMESTAMP_WINDOW_SECONDS = 300;
const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_NONCE_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** `${timestamp}.${nonce}` → expiry, for requests that already verified. */
const usedNonces = new Map<string, number>();

export function isIntegrationConfigured(): boolean {
  return Boolean(process.env.INTEGRATION_SHARED_SECRET?.trim());
}

export type IntegrationAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; message: string };

function reject(status: 401 | 500, message: string): IntegrationAuthResult {
  return { ok: false, status, message };
}

function pruneNonces(now: number): void {
  for (const [key, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(key);
  }
}

/**
 * Verify the HMAC headers against the exact raw body bytes.
 *
 * Callers must read the body ONCE and pass those bytes here; re-serialising
 * parsed JSON would change the bytes and never match. Bytes (not a string) so
 * a multipart upload can be signed without a UTF-8 round-trip corrupting it.
 */
export function verifyIntegrationRequestBytes(
  request: NextRequest,
  rawBody: Buffer,
): IntegrationAuthResult {
  const secret = process.env.INTEGRATION_SHARED_SECRET?.trim();
  if (!secret) return reject(500, 'integration API is not configured');

  const timestamp = request.headers.get('x-openmaic-timestamp')?.trim();
  const nonce = request.headers.get('x-openmaic-nonce')?.trim();
  const signature = request.headers.get('x-openmaic-signature')?.trim();

  if (!timestamp || !nonce || !signature) {
    return reject(401, 'missing integration signature headers');
  }
  if (!/^\d+$/.test(timestamp)) return reject(401, 'invalid integration timestamp');
  if (nonce.length > MAX_NONCE_LENGTH) return reject(401, 'invalid integration nonce');

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > TIMESTAMP_WINDOW_SECONDS) {
    return reject(401, 'integration timestamp is outside the accepted window');
  }

  const now = Date.now();
  pruneNonces(now);
  const nonceKey = `${timestamp}.${nonce}`;
  if (usedNonces.has(nonceKey)) return reject(401, 'integration request was already used');

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.`)
    .update(rawBody)
    .digest('hex');
  const provided = signature.toLowerCase();
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (
    expectedBytes.length !== providedBytes.length ||
    !timingSafeEqual(expectedBytes, providedBytes)
  ) {
    return reject(401, 'invalid integration signature');
  }

  usedNonces.set(nonceKey, now + NONCE_TTL_MS);
  return { ok: true };
}

/** String-body convenience wrapper for the JSON endpoints. */
export function verifyIntegrationRequest(
  request: NextRequest,
  rawBody: string,
): IntegrationAuthResult {
  return verifyIntegrationRequestBytes(request, Buffer.from(rawBody, 'utf8'));
}

/**
 * Authentication for the multipart extract endpoint.
 *
 * Signing a multipart body requires the platform to build the exact bytes
 * before sending, which many HTTP clients make awkward. This endpoint
 * therefore also accepts `Authorization: Bearer <shared secret>`; the JSON
 * endpoints keep HMAC-only. Over plain HTTP a bearer token is visible to a
 * network sniffer, so prefer HMAC or HTTPS on untrusted networks.
 */
export function verifyIntegrationUploadAuth(
  request: NextRequest,
  rawBody: Buffer,
): IntegrationAuthResult {
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) return verifyIntegrationRequestBytes(request, rawBody);

  const secret = process.env.INTEGRATION_SHARED_SECRET?.trim();
  if (!secret) return reject(500, 'integration API is not configured');

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return reject(401, 'invalid authorization header');
  const provided = createHash('sha256').update(match[1].trim()).digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(provided, expected)
    ? { ok: true }
    : reject(401, 'invalid integration token');
}

/**
 * A stable job id derived from the platform's idempotency key, scoped to the
 * tenant. Repeating the same request therefore finds the original job instead
 * of starting a second course.
 */
export function integrationJobId(tenantId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 24);
  return `int_${digest}`;
}

/** Job ids created by this API; the status endpoint refuses anything else. */
export function isIntegrationJobId(jobId: string): boolean {
  return /^int_[0-9a-f]{24}$/.test(jobId);
}

export function isValidIdempotencyKey(value: string | null): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IDEMPOTENCY_KEY_LENGTH;
}

/**
 * The browser-facing origin used in returned links.
 *
 * A platform backend may call OpenMAIC through an internal address that end
 * users cannot open, so the deployment can pin the public origin explicitly.
 */
export function integrationBaseUrl(request: NextRequest): string {
  const configured = process.env.INTEGRATION_PUBLIC_BASE_URL?.trim();
  return (configured || buildRequestOrigin(request)).replace(/\/+$/, '');
}
