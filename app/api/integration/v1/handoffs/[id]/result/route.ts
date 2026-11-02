/**
 * POST /api/integration/v1/handoffs/[id]/result
 *
 * Browser-facing completion report from the generation preview. The per-handoff
 * completion token is required, so the handoff id alone cannot mark a result.
 */
import type { NextRequest } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { integrationBaseUrl, isIntegrationConfigured } from '@/lib/server/integration/auth';
import { completeIntegrationHandoff } from '@/lib/server/integration/handoffs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STAGE_ID_PATTERN = /^[A-Za-z0-9_-]{6,80}$/;

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isIntegrationConfigured()) return new Response('Not found', { status: 404 });

  const { id } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }

  const completionToken =
    typeof body.completionToken === 'string' ? body.completionToken.trim() : '';
  const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';

  if (!completionToken) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'completionToken is required');
  }
  if (!STAGE_ID_PATTERN.test(stageId)) {
    return apiError('INVALID_REQUEST', 400, 'stageId is invalid');
  }

  const handoff = await completeIntegrationHandoff({
    id,
    completionToken,
    stageId,
    // The platform needs a browser-facing URL, not the origin the teacher's
    // tab happened to use (`127.0.0.1`, an internal host, …). The deployment
    // pins that origin; never trust a client-supplied one.
    resourceUrl: `${integrationBaseUrl(req)}/classroom/${stageId}`,
  });
  if (!handoff) {
    return apiError('UNAUTHENTICATED', 403, 'invalid or expired handoff/completion token');
  }

  return apiSuccess({
    handoffId: handoff.id,
    status: handoff.status,
    stageId: handoff.stageId,
    resourceUrl: handoff.resourceUrl,
  });
}
