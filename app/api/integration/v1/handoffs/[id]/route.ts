/**
 * GET /api/integration/v1/handoffs/[id]
 *
 * Platform-facing status: pending until the browser reports the generated
 * course, then succeeded with the stage/resource URL. HMAC over the empty body.
 */
import type { NextRequest } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isIntegrationConfigured, verifyIntegrationRequest } from '@/lib/server/integration/auth';
import { readIntegrationHandoff } from '@/lib/server/integration/handoffs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isIntegrationConfigured()) return new Response('Not found', { status: 404 });

  const auth = verifyIntegrationRequest(req, '');
  if (!auth.ok) return apiError('UNAUTHENTICATED', auth.status, auth.message);

  const { id } = await context.params;
  const handoff = await readIntegrationHandoff(id);
  if (!handoff) {
    return apiError('INVALID_REQUEST', 404, 'handoff not found or expired');
  }

  return apiSuccess({
    handoffId: handoff.id,
    status: handoff.status,
    createdAt: handoff.createdAt,
    expiresAt: handoff.expiresAt,
    ...(handoff.stageId ? { stageId: handoff.stageId } : {}),
    ...(handoff.resourceUrl ? { resourceUrl: handoff.resourceUrl } : {}),
  });
}
