/**
 * HMAC authentication for the integration API.
 *
 * The signature covers the exact raw body, so a captured request cannot be
 * replayed with a different payload; the timestamp window and nonce cache bound
 * replay of the original.
 */
import { createHmac } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyIntegrationRequest } from '@/lib/server/integration/auth';

const SECRET = 'test-integration-secret';

function sign(body: string, timestamp: number, nonce: string): string {
  return createHmac('sha256', SECRET).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

function request(
  body: string,
  options: {
    timestamp?: number;
    nonce?: string;
    signature?: string;
    omit?: 'timestamp' | 'nonce' | 'signature';
  } = {},
): NextRequest {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = options.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
  const signature = options.signature ?? sign(body, timestamp, nonce);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.omit !== 'timestamp') headers.set('x-openmaic-timestamp', String(timestamp));
  if (options.omit !== 'nonce') headers.set('x-openmaic-nonce', nonce);
  if (options.omit !== 'signature') headers.set('x-openmaic-signature', signature);
  return new NextRequest('http://localhost/api/integration/v1/outlines', {
    method: 'POST',
    headers,
    body,
  });
}

describe('verifyIntegrationRequest', () => {
  beforeEach(() => {
    vi.stubEnv('INTEGRATION_SHARED_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a correctly signed request', () => {
    expect(verifyIntegrationRequest(request('{"a":1}'), '{"a":1}')).toEqual({ ok: true });
  });

  it('rejects a wrong signature', () => {
    const result = verifyIntegrationRequest(
      request('{"a":1}', { signature: '0'.repeat(64) }),
      '{"a":1}',
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a body changed after signing', () => {
    const signed = request('{"a":1}');
    expect(verifyIntegrationRequest(signed, '{"a":2}')).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects an old timestamp', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 600;
    expect(verifyIntegrationRequest(request('{}', { timestamp }), '{}')).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects a replayed nonce', () => {
    const nonce = 'replay-once';
    const timestamp = Math.floor(Date.now() / 1000);
    expect(verifyIntegrationRequest(request('{}', { timestamp, nonce }), '{}')).toEqual({
      ok: true,
    });
    expect(verifyIntegrationRequest(request('{}', { timestamp, nonce }), '{}')).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects missing headers', () => {
    expect(verifyIntegrationRequest(request('{}', { omit: 'signature' }), '{}')).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('reports an unconfigured deployment instead of authenticating everything', () => {
    vi.stubEnv('INTEGRATION_SHARED_SECRET', '');
    expect(verifyIntegrationRequest(request('{}'), '{}')).toMatchObject({
      ok: false,
      status: 500,
    });
  });
});
