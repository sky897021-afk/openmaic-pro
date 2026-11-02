/**
 * Module 2 handoff lifecycle, exercised end-to-end against the real file
 * stores: create (HMAC) → status → payload (browser) → result (token).
 */
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteIntegrationHandoff,
  readIntegrationHandoff,
} from '@/lib/server/integration/handoffs';
import {
  deleteIntegrationMaterial,
  saveIntegrationMaterial,
} from '@/lib/server/integration/materials';

const SECRET = 'test-secret';
const BASE = 'http://openmaic.test';
const HANDOFF_URL = 'http://localhost/api/integration/v1/handoffs';

function signedHeaders(body: string): Headers {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
  const signature = createHmac('sha256', SECRET)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');
  return new Headers({
    'content-type': 'application/json',
    'x-openmaic-timestamp': String(timestamp),
    'x-openmaic-nonce': nonce,
    'x-openmaic-signature': signature,
  });
}

let handoffId: string | undefined;
let materialId: string | undefined;

beforeEach(() => {
  vi.stubEnv('INTEGRATION_SHARED_SECRET', SECRET);
  vi.stubEnv('INTEGRATION_PUBLIC_BASE_URL', BASE);
});

afterEach(async () => {
  if (handoffId) await deleteIntegrationHandoff(handoffId);
  if (materialId) await deleteIntegrationMaterial(materialId);
  handoffId = undefined;
  materialId = undefined;
  vi.unstubAllEnvs();
});

describe('integration handoff lifecycle', () => {
  it('creates a handoff, serves its payload, and records the result with the token', async () => {
    const material = await saveIntegrationMaterial(
      {
        tenantId: 'dfsm',
        fileName: 'material.txt',
        mimeType: 'text/plain',
        kind: 'txt',
        size: 12,
        parser: 'plain-text',
        text: '裂解工段操作说明',
        images: [],
        layout: {},
      },
      { bytes: Buffer.from('裂解工段操作说明'), fileName: 'material.txt' },
    );
    materialId = material.id;

    const { POST } = await import('@/app/api/integration/v1/handoffs/route');
    const body = JSON.stringify({
      tenantId: 'dfsm',
      prompt: '生成一个关于裂解工段流程的单游戏互动资源',
      materialIds: [material.id],
      mode: 'single-game',
      returnUrl: 'http://platform.example/chapter/9',
    });
    const created = await POST(
      new NextRequest(HANDOFF_URL, {
        method: 'POST',
        headers: signedHeaders(body),
        body,
      }),
    );
    const createdJson = await created.json();

    expect(created.status).toBe(200);
    expect(createdJson.handoffId).toMatch(/^ho_/);
    expect(createdJson.redirectUrl).toBe(`${BASE}/game?handoff=${createdJson.handoffId}`);
    handoffId = createdJson.handoffId;

    // Platform status (HMAC, empty body).
    const { GET: getStatus } = await import('@/app/api/integration/v1/handoffs/[id]/route');
    const status = await getStatus(
      new NextRequest(`${HANDOFF_URL}/${handoffId}`, { headers: signedHeaders('') }),
      { params: Promise.resolve({ id: handoffId! }) },
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      handoffId,
      status: 'pending',
    });

    // Browser payload (opaque id, no HMAC).
    const { GET: getPayload } =
      await import('@/app/api/integration/v1/handoffs/[id]/payload/route');
    const payload = await getPayload(new NextRequest(`${HANDOFF_URL}/${handoffId}/payload`), {
      params: Promise.resolve({ id: handoffId! }),
    });
    const payloadJson = await payload.json();
    expect(payload.status).toBe(200);
    expect(payloadJson).toMatchObject({
      handoff: {
        prompt: '生成一个关于裂解工段流程的单游戏互动资源',
        mode: 'single-game',
      },
    });
    expect(payloadJson.materials[0]).toMatchObject({
      id: material.id,
      text: '裂解工段操作说明',
    });
    expect(typeof payloadJson.handoff.completionToken).toBe('string');

    // A wrong token cannot write a result.
    const { POST: postResult } =
      await import('@/app/api/integration/v1/handoffs/[id]/result/route');
    const wrong = await postResult(
      new NextRequest(`${HANDOFF_URL}/${handoffId}/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          completionToken: 'not-the-token',
          stageId: 'stage-test1',
        }),
      }),
      { params: Promise.resolve({ id: handoffId! }) },
    );
    expect(wrong.status).toBe(403);

    const result = await postResult(
      new NextRequest(`${HANDOFF_URL}/${handoffId}/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          completionToken: payloadJson.handoff.completionToken,
          stageId: 'stage-test1',
          resourceUrl: `${BASE}/classroom/stage-test1`,
        }),
      }),
      { params: Promise.resolve({ id: handoffId! }) },
    );
    expect(result.status).toBe(200);

    const stored = await readIntegrationHandoff(handoffId!);
    expect(stored).toMatchObject({
      status: 'succeeded',
      stageId: 'stage-test1',
      resourceUrl: `${BASE}/classroom/stage-test1`,
    });
  });

  it('rejects a handoff that references an unknown material', async () => {
    const { POST } = await import('@/app/api/integration/v1/handoffs/route');
    const body = JSON.stringify({
      tenantId: 'dfsm',
      prompt: '生成一个单游戏',
      materialIds: ['mat_doesnotexist'],
      mode: 'single-game',
    });
    const res = await POST(
      new NextRequest(HANDOFF_URL, {
        method: 'POST',
        headers: signedHeaders(body),
        body,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('unknown or expired materialIds');
  });

  it('rejects a valid material owned by another tenant', async () => {
    const material = await saveIntegrationMaterial(
      {
        tenantId: 'tenant-a',
        fileName: 'private.txt',
        mimeType: 'text/plain',
        kind: 'txt',
        size: 13,
        parser: 'plain-text',
        text: 'private source',
        images: [],
        layout: {},
      },
      { bytes: Buffer.from('private source'), fileName: 'private.txt' },
    );
    materialId = material.id;

    const { POST } = await import('@/app/api/integration/v1/handoffs/route');
    const body = JSON.stringify({
      tenantId: 'tenant-b',
      prompt: 'Generate a game from this source',
      materialIds: [material.id],
      mode: 'single-game',
    });
    const res = await POST(
      new NextRequest(HANDOFF_URL, {
        method: 'POST',
        headers: signedHeaders(body),
        body,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('do not belong to tenantId "tenant-b"');
    expect(json.error).toContain(material.id);
  });

  it('returns 410 when a material tenant changes after the handoff is created', async () => {
    const material = await saveIntegrationMaterial(
      {
        tenantId: 'tenant-a',
        fileName: 'source.txt',
        mimeType: 'text/plain',
        kind: 'txt',
        size: 12,
        parser: 'plain-text',
        text: 'source bytes',
        images: [],
        layout: {},
      },
      { bytes: Buffer.from('source bytes'), fileName: 'source.txt' },
    );
    materialId = material.id;

    const { POST } = await import('@/app/api/integration/v1/handoffs/route');
    const body = JSON.stringify({
      tenantId: 'tenant-a',
      prompt: 'Generate a game from this source',
      materialIds: [material.id],
      mode: 'single-game',
    });
    const created = await POST(
      new NextRequest(HANDOFF_URL, {
        method: 'POST',
        headers: signedHeaders(body),
        body,
      }),
    );
    const createdJson = await created.json();
    expect(created.status).toBe(200);
    handoffId = createdJson.handoffId;

    const metaPath = path.join(
      process.cwd(),
      'data',
      'integration-materials',
      material.id,
      'meta.json',
    );
    const stored = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    stored.tenantId = 'tenant-b';
    await fs.writeFile(metaPath, JSON.stringify(stored, null, 2), 'utf8');

    const { GET: getPayload } =
      await import('@/app/api/integration/v1/handoffs/[id]/payload/route');
    const payload = await getPayload(new NextRequest(`${HANDOFF_URL}/${handoffId}/payload`), {
      params: Promise.resolve({ id: handoffId! }),
    });
    const payloadJson = await payload.json();

    expect(payload.status).toBe(410);
    expect(payloadJson.error).toContain('no longer available');
  });
});
