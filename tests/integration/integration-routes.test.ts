/**
 * The three integration endpoints, exercised at the HTTP boundary.
 *
 * The heavy pipeline is mocked: these tests pin authentication, the contract,
 * idempotency, and the shape the platform receives.
 */
import { createHmac } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  generateClassicOutlines: vi.fn(),
  createJobIfAbsent: vi.fn(),
  readJob: vi.fn(),
  runJob: vi.fn(),
  readIntegrationMaterialContext: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mocks.after,
}));

vi.mock('@/lib/server/classroom-generation', () => ({
  generateClassicOutlines: mocks.generateClassicOutlines,
}));

vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJobIfAbsent: mocks.createJobIfAbsent,
  readClassroomGenerationJob: mocks.readJob,
}));

vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runJob,
}));

vi.mock('@/lib/server/integration/material-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/integration/material-context')>()),
  readIntegrationMaterialContext: mocks.readIntegrationMaterialContext,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { POST as postOutlines } from '@/app/api/integration/v1/outlines/route';
import { POST as postCourses } from '@/app/api/integration/v1/courses/route';
import { GET as getJob } from '@/app/api/integration/v1/courses/jobs/[jobId]/route';
import { POST as postMaterials } from '@/app/api/integration/v1/materials/route';
import { MAX_TENANT_CHARS } from '@/lib/server/integration/contract';

const SECRET = 'test-secret';
const PUBLIC_BASE = 'http://openmaic.test';

function signedHeaders(
  body: string,
  options: { secret?: string; idempotencyKey?: string } = {},
): Headers {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');
  const headers = new Headers({
    'content-type': 'application/json',
    'x-openmaic-timestamp': String(timestamp),
    'x-openmaic-nonce': nonce,
    'x-openmaic-signature': signature,
  });
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
  return headers;
}

function post(
  url: string,
  body: unknown,
  options: { secret?: string; idempotencyKey?: string } = {},
) {
  const raw = JSON.stringify(body);
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: signedHeaders(raw, options),
    body: raw,
  });
}

const page = {
  id: 'scene_1',
  order: 1,
  type: 'slide',
  title: '裂解工段总览',
  description: '介绍裂解工段的整体流程',
  keyPoints: ['原料', '裂解炉'],
};

const outlineBody = {
  tenantId: 'dfsm',
  requirement: '生成一节完整课程',
  materials: [{ title: '手册', kind: 'docx', text: '正文' }],
};

const courseBody = {
  ...outlineBody,
  outlines: [page],
  courseTitle: '乙烯裂解流程认知',
  languageDirective: 'zh',
};

beforeEach(() => {
  vi.stubEnv('INTEGRATION_SHARED_SECRET', SECRET);
  vi.stubEnv('INTEGRATION_PUBLIC_BASE_URL', PUBLIC_BASE);
  mocks.after.mockReset();
  mocks.generateClassicOutlines.mockReset();
  mocks.createJobIfAbsent.mockReset();
  mocks.readJob.mockReset();
  mocks.runJob.mockReset();
  mocks.readIntegrationMaterialContext.mockReset();
  mocks.generateClassicOutlines.mockResolvedValue({
    courseTitle: '乙烯裂解流程认知',
    languageDirective: 'zh',
    outlines: [page],
  });
  mocks.readJob.mockResolvedValue(null);
  mocks.createJobIfAbsent.mockResolvedValue({
    created: true,
    job: { status: 'queued' },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/integration/v1/outlines', () => {
  it('is absent when the deployment has no shared secret', async () => {
    vi.stubEnv('INTEGRATION_SHARED_SECRET', '');
    const res = await postOutlines(post('/api/integration/v1/outlines', outlineBody));
    expect(res.status).toBe(404);
  });

  it('refuses an unsigned request', async () => {
    const res = await postOutlines(
      new NextRequest('http://localhost/api/integration/v1/outlines', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(outlineBody),
      }),
    );
    expect(res.status).toBe(401);
    expect(mocks.generateClassicOutlines).not.toHaveBeenCalled();
  });

  it('returns the generated outline and passes material text to the pipeline', async () => {
    const res = await postOutlines(post('/api/integration/v1/outlines', outlineBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      courseTitle: '乙烯裂解流程认知',
      languageDirective: 'zh',
      outlines: [page],
    });
    expect(typeof json.outlineId).toBe('string');
    expect(mocks.generateClassicOutlines).toHaveBeenCalledWith(
      expect.objectContaining({
        requirement: '生成一节完整课程',
        pdfContent: { text: expect.stringContaining('正文'), images: [] },
      }),
    );
  });

  it('reloads materialIds with image context, including an image-only source', async () => {
    const materialId = 'mat_12345678';
    const src = 'data:image/png;base64,AAAA';
    const record = {
      id: materialId,
      tenantId: 'dfsm',
      fileName: 'layout.png',
      mimeType: 'image/png',
      kind: 'png',
      size: 4,
      createdAt: new Date().toISOString(),
      parser: 'local-document',
      text: '',
      images: [],
      layout: { pageCount: 1, pages: [{ index: 1, src }] },
    };
    mocks.readIntegrationMaterialContext.mockResolvedValue({
      ok: true,
      value: {
        records: [record],
        text: '',
        images: [src],
        pdfImages: [{ id: 'img_1', src, pageNumber: 1 }],
        imageMapping: { img_1: src },
        textTruncated: false,
      },
    });

    const res = await postOutlines(
      post('/api/integration/v1/outlines', {
        tenantId: 'dfsm',
        requirement: 'Use the uploaded image',
        materialIds: [materialId],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.materialIds).toEqual([materialId]);
    expect(json.materials).toEqual([
      expect.objectContaining({
        materialId,
        fileName: 'layout.png',
        pageCount: 1,
        layoutPageCount: 1,
      }),
    ]);
    expect(mocks.generateClassicOutlines).toHaveBeenCalledWith(
      expect.objectContaining({
        pdfContent: {
          text: '',
          images: [src],
          pdfImages: [{ id: 'img_1', src, pageNumber: 1 }],
          imageMapping: { img_1: src },
        },
      }),
    );
  });

  it('rejects an invalid contract before calling the model', async () => {
    const res = await postOutlines(
      post('/api/integration/v1/outlines', { tenantId: 'dfsm', requirement: '' }),
    );
    expect(res.status).toBe(400);
    expect(mocks.generateClassicOutlines).not.toHaveBeenCalled();
  });

  it('maps a model failure to a readable 502', async () => {
    mocks.generateClassicOutlines.mockRejectedValue(new Error('model unavailable'));
    const res = await postOutlines(post('/api/integration/v1/outlines', outlineBody));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.errorCode).toBe('GENERATION_FAILED');
    expect(json.details).toContain('model unavailable');
  });
});

describe('POST /api/integration/v1/courses', () => {
  it('requires an Idempotency-Key', async () => {
    const res = await postCourses(post('/api/integration/v1/courses', courseBody));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.errorCode).toBe('MISSING_REQUIRED_FIELD');
    expect(mocks.createJobIfAbsent).not.toHaveBeenCalled();
  });

  it('queues the job with the approved outline and a stable id', async () => {
    const res = await postCourses(
      post('/api/integration/v1/courses', courseBody, { idempotencyKey: 'chapter-9-v1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json.jobId).toMatch(/^int_[0-9a-f]{24}$/);
    expect(json.pollUrl).toBe(`${PUBLIC_BASE}/api/integration/v1/courses/jobs/${json.jobId}`);
    expect(json.reused).toBe(false);

    const [jobId, input] = mocks.createJobIfAbsent.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(jobId).toBe(json.jobId);
    expect(input.outlines).toEqual([page]);
    expect(input.courseTitle).toBe('乙烯裂解流程认知');
    expect(input.languageDirective).toBe('zh');
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it('returns the original job for a repeated idempotency key', async () => {
    mocks.readJob.mockResolvedValue({ status: 'running' });
    const res = await postCourses(
      post('/api/integration/v1/courses', courseBody, { idempotencyKey: 'chapter-9-v1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toMatchObject({ status: 'running', reused: true });
    expect(mocks.createJobIfAbsent).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('schedules only one generation when the same key is posted concurrently', async () => {
    mocks.createJobIfAbsent
      .mockResolvedValueOnce({ created: true, job: { status: 'queued' } })
      .mockResolvedValueOnce({ created: false, job: { status: 'queued' } });

    const [first, second] = await Promise.all([
      postCourses(
        post('/api/integration/v1/courses', courseBody, { idempotencyKey: 'chapter-9-v1' }),
      ),
      postCourses(
        post('/api/integration/v1/courses', courseBody, { idempotencyKey: 'chapter-9-v1' }),
      ),
    ]);
    const bodies = await Promise.all([first.json(), second.json()]);

    expect([first.status, second.status]).toEqual([202, 202]);
    expect(bodies.map((body) => body.reused).sort()).toEqual([false, true]);
    expect(mocks.createJobIfAbsent).toHaveBeenCalledTimes(2);
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid materialIds instead of falling back to legacy material text', async () => {
    mocks.readIntegrationMaterialContext.mockResolvedValue({
      ok: false,
      message: 'materialIds[0] is unavailable',
    });
    const res = await postCourses(
      post(
        '/api/integration/v1/courses',
        {
          ...courseBody,
          materialIds: ['mat_12345678'],
        },
        { idempotencyKey: 'chapter-9-v1' },
      ),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.details).toContain('materialIds[0]');
    expect(mocks.createJobIfAbsent).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('rejects a plan that contains a PBL page', async () => {
    const res = await postCourses(
      post(
        '/api/integration/v1/courses',
        { ...courseBody, outlines: [{ ...page, type: 'pbl' }] },
        { idempotencyKey: 'chapter-9-v1' },
      ),
    );
    expect(res.status).toBe(400);
    expect(mocks.createJobIfAbsent).not.toHaveBeenCalled();
  });
});

describe('POST /api/integration/v1/materials', () => {
  function materialRequest(fields: Record<string, string>) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    form.set('files', new File(['lesson body'], 'lesson.txt', { type: 'text/plain' }));
    return new NextRequest('http://localhost/api/integration/v1/materials', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: form,
    });
  }

  it('requires a tenant for stored materials', async () => {
    const res = await postMaterials(materialRequest({}));
    expect(res.status).toBe(400);
  });

  it('rejects an oversized tenant instead of truncating its identity', async () => {
    const res = await postMaterials(
      materialRequest({ tenantId: 't'.repeat(MAX_TENANT_CHARS + 1) }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/integration/v1/courses/jobs/[jobId]', () => {
  const jobId = 'int_0123456789abcdef01234567';

  it('refuses an id that was not minted by this API', async () => {
    const res = await getJob(
      new NextRequest(`http://localhost/api/integration/v1/courses/jobs/job-1`, {
        headers: signedHeaders(''),
      }),
      { params: Promise.resolve({ jobId: 'job-1' }) },
    );
    expect(res.status).toBe(400);
  });

  it('returns progress and the classroom link when done', async () => {
    mocks.readJob.mockResolvedValue({
      id: jobId,
      status: 'succeeded',
      step: 'completed',
      progress: 100,
      message: 'done',
      scenesGenerated: 1,
      totalScenes: 1,
      result: {
        classroomId: 'AbC123xyz',
        url: `${PUBLIC_BASE}/classroom/AbC123xyz`,
        scenesCount: 1,
      },
    });

    const res = await getJob(
      new NextRequest(`http://localhost/api/integration/v1/courses/jobs/${jobId}`, {
        headers: signedHeaders(''),
      }),
      { params: Promise.resolve({ jobId }) },
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      jobId,
      status: 'succeeded',
      done: true,
      result: {
        stageId: 'AbC123xyz',
        classroomUrl: `${PUBLIC_BASE}/classroom/AbC123xyz`,
        scenesCount: 1,
      },
    });
  });

  it('returns 404 for an unknown job', async () => {
    mocks.readJob.mockResolvedValue(null);
    const res = await getJob(
      new NextRequest(`http://localhost/api/integration/v1/courses/jobs/${jobId}`, {
        headers: signedHeaders(''),
      }),
      { params: Promise.resolve({ jobId }) },
    );
    expect(res.status).toBe(404);
  });
});
