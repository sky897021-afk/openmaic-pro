/**
 * POST /api/integration/v1/extract at the HTTP boundary.
 *
 * Pins the multipart contract, both authentication modes (HMAC over the raw
 * bytes, and the Bearer fallback), batch limits, and the per-file failure
 * behavior that lets one unreadable upload coexist with successful ones.
 */
import { createHmac } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extract: vi.fn(),
}));

vi.mock('@/lib/server/integration/extract', () => ({
  extractIntegrationFile: mocks.extract,
}));

// Keep the "file too large" case cheap: the real limit is 50 MB.
vi.mock('@/lib/constants/generation', () => ({
  MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES: 10,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { POST } from '@/app/api/integration/v1/extract/route';

const SECRET = 'test-secret';
const URL = 'http://localhost/api/integration/v1/extract';

interface Upload {
  name: string;
  type: string;
  content: string | Buffer;
}

function multipart(files: readonly Upload[]): { body: Buffer; contentType: string } {
  const boundary = '----openmaic-test-boundary';
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function bearerRequest(files: readonly Upload[]): NextRequest {
  const { body, contentType } = multipart(files);
  return new NextRequest(URL, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${SECRET}` },
    body: new Uint8Array(body),
  });
}

function signedRequest(files: readonly Upload[]): NextRequest {
  const { body, contentType } = multipart(files);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
  const signature = createHmac('sha256', SECRET)
    .update(`${timestamp}.${nonce}.`)
    .update(body)
    .digest('hex');
  return new NextRequest(URL, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-openmaic-timestamp': String(timestamp),
      'x-openmaic-nonce': nonce,
      'x-openmaic-signature': signature,
    },
    body: new Uint8Array(body),
  });
}

beforeEach(() => {
  vi.stubEnv('INTEGRATION_SHARED_SECRET', SECRET);
  mocks.extract.mockReset();
  mocks.extract.mockImplementation(async (input: { fileName: string }) => ({
    fileName: input.fileName,
    mimeType: 'text/plain',
    kind: 'txt',
    text: '提取到的文本',
    parser: 'plain-text',
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/integration/v1/extract', () => {
  it('is absent when the deployment has no shared secret', async () => {
    vi.stubEnv('INTEGRATION_SHARED_SECRET', '');
    const res = await POST(bearerRequest([{ name: 'a.txt', type: 'text/plain', content: 'hi' }]));
    expect(res.status).toBe(404);
  });

  it('refuses an unauthenticated request', async () => {
    const { body, contentType } = multipart([{ name: 'a.txt', type: 'text/plain', content: 'hi' }]);
    const res = await POST(
      new NextRequest(URL, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: new Uint8Array(body),
      }),
    );
    expect(res.status).toBe(401);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('accepts the Bearer fallback and returns one result per file', async () => {
    const res = await POST(
      bearerRequest([
        { name: 'a.txt', type: 'text/plain', content: 'one' },
        { name: 'b.md', type: 'text/markdown', content: 'two' },
      ]),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.materials).toHaveLength(2);
    expect(json.materials[0]).toMatchObject({
      fileName: 'a.txt',
      text: '提取到的文本',
      parser: 'plain-text',
    });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
  });

  it('accepts HMAC signed over the raw multipart bytes', async () => {
    const res = await POST(
      signedRequest([{ name: 'a.txt', type: 'text/plain', content: 'hello' }]),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a request with no files', async () => {
    const res = await POST(bearerRequest([]));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.errorCode).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects more than ten files', async () => {
    const files = Array.from({ length: 11 }, (_, index) => ({
      name: `f${index}.txt`,
      type: 'text/plain',
      content: 'x',
    }));
    const res = await POST(bearerRequest(files));
    expect(res.status).toBe(400);
  });

  it('reports an oversized file without failing the batch', async () => {
    const res = await POST(
      bearerRequest([
        { name: 'big.txt', type: 'text/plain', content: 'x'.repeat(11) },
        { name: 'ok.txt', type: 'text/plain', content: 'ok' },
      ]),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.materials[0].error).toContain('exceeds');
    expect(json.materials[1].text).toBe('提取到的文本');
    // Only the acceptable file reached the extractor.
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });

  it('reports an empty file without failing the batch', async () => {
    const res = await POST(bearerRequest([{ name: 'empty.txt', type: 'text/plain', content: '' }]));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.materials[0].error).toContain('empty');
  });

  it('turns one extractor failure into a per-file error', async () => {
    mocks.extract.mockRejectedValueOnce(new Error('parser exploded')).mockResolvedValueOnce({
      fileName: 'b.txt',
      mimeType: 'text/plain',
      kind: 'txt',
      text: 'second',
      parser: 'plain-text',
    });

    const res = await POST(
      bearerRequest([
        { name: 'a.txt', type: 'text/plain', content: 'one' },
        { name: 'b.txt', type: 'text/plain', content: 'two' },
      ]),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.materials[0].error).toContain('parser exploded');
    expect(json.materials[1].text).toBe('second');
  });
});
