/**
 * POST /api/integration/v1/handoffs
 *
 * Create the browser handoff that module 2 redirects to:
 * `/game?handoff=<id>`. The platform has already uploaded materials through
 * `/materials`; this endpoint only validates their ids and freezes the prompt /
 * return target. HMAC over the JSON body.
 */
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  integrationBaseUrl,
  isIntegrationConfigured,
  verifyIntegrationRequest,
} from '@/lib/server/integration/auth';
import { MAX_TENANT_CHARS } from '@/lib/server/integration/contract';
import { createIntegrationHandoff } from '@/lib/server/integration/handoffs';
import { readIntegrationMaterial } from '@/lib/server/integration/materials';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_MATERIALS = 20;
const log = createLogger('IntegrationHandoffs');

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function parseReturnUrl(value: unknown): string | undefined | null {
  const raw = text(value, 2_000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!isIntegrationConfigured()) return new Response('Not found', { status: 404 });

  const rawBody = await req.text();
  const auth = verifyIntegrationRequest(req, rawBody);
  if (!auth.ok) return apiError('UNAUTHENTICATED', auth.status, auth.message);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return apiError('INVALID_REQUEST', 400, 'body must be a JSON object');
  }

  const tenantId = text(body.tenantId, Number.MAX_SAFE_INTEGER);
  if (!tenantId) return apiError('INVALID_REQUEST', 400, 'tenantId is required');
  if (tenantId.length > MAX_TENANT_CHARS) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `tenantId must be at most ${MAX_TENANT_CHARS} characters`,
    );
  }

  const prompt = text(body.prompt, 20_000);
  if (!prompt) return apiError('INVALID_REQUEST', 400, 'prompt is required');

  if (body.mode !== undefined && body.mode !== 'single-game') {
    return apiError('INVALID_REQUEST', 400, 'mode must be "single-game"');
  }

  const materialIds = Array.isArray(body.materialIds)
    ? [...new Set(body.materialIds.map((id) => (typeof id === 'string' ? id.trim() : '')))]
    : [];
  if (materialIds.length === 0 || materialIds.some((id) => !id)) {
    return apiError('INVALID_REQUEST', 400, 'materialIds must be a non-empty array of ids');
  }
  if (materialIds.length > MAX_MATERIALS) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `materialIds cannot contain more than ${MAX_MATERIALS} entries`,
    );
  }

  const returnUrl = parseReturnUrl(body.returnUrl);
  if (returnUrl === null) {
    return apiError('INVALID_REQUEST', 400, 'returnUrl must be an absolute http(s) URL');
  }

  const materials = await Promise.all(materialIds.map((id) => readIntegrationMaterial(id)));
  const missing = materialIds.filter((_id, index) => materials[index] === null);
  if (missing.length > 0) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `unknown or expired materialIds: ${missing.join(', ')}`,
    );
  }
  const foreign = materialIds.filter(
    (_id, index) => materials[index]?.tenantId !== tenantId,
  );
  if (foreign.length > 0) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `materialIds do not belong to tenantId "${tenantId}": ${foreign.join(', ')}`,
    );
  }

  const handoff = await createIntegrationHandoff({
    tenantId,
    prompt,
    materialIds,
    ...(text(body.teacherId, 200) ? { teacherId: text(body.teacherId, 200) } : {}),
    ...(text(body.externalCourseId, 200)
      ? { externalCourseId: text(body.externalCourseId, 200) }
      : {}),
    ...(text(body.externalChapterId, 200)
      ? { externalChapterId: text(body.externalChapterId, 200) }
      : {}),
    ...(returnUrl ? { returnUrl } : {}),
  });

  log.info(`Created handoff ${handoff.id} [tenant=${tenantId}, materials=${materialIds.length}]`);

  return apiSuccess({
    handoffId: handoff.id,
    redirectUrl: `${integrationBaseUrl(req)}/game?handoff=${encodeURIComponent(handoff.id)}`,
    status: handoff.status,
    expiresAt: handoff.expiresAt,
  });
}
