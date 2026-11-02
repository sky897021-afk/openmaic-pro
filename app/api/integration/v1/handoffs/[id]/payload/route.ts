/**
 * GET /api/integration/v1/handoffs/[id]/payload
 *
 * Browser-facing read for the `/game?handoff=<id>` landing page. Possession of
 * the opaque handoff id is the read capability; the response includes the
 * per-handoff completion token the page needs to report its result. No listing
 * endpoint, no HMAC secret in the page.
 */
import type { NextRequest } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isIntegrationConfigured } from '@/lib/server/integration/auth';
import { readIntegrationHandoff } from '@/lib/server/integration/handoffs';
import { readIntegrationMaterial } from '@/lib/server/integration/materials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isIntegrationConfigured()) return new Response('Not found', { status: 404 });

  const { id } = await context.params;
  const handoff = await readIntegrationHandoff(id);
  if (!handoff) {
    return apiError('INVALID_REQUEST', 404, 'handoff not found or expired');
  }

  const materials = await Promise.all(
    handoff.materialIds.map((materialId) => readIntegrationMaterial(materialId)),
  );
  if (materials.some((material) => material === null)) {
    return apiError('INVALID_REQUEST', 410, 'one or more materials have expired');
  }
  if (materials.some((material) => material?.tenantId !== handoff.tenantId)) {
    return apiError('INVALID_REQUEST', 410, 'one or more materials are no longer available');
  }

  const response = apiSuccess({
    handoff: {
      id: handoff.id,
      prompt: handoff.prompt,
      mode: handoff.mode,
      ...(handoff.returnUrl ? { returnUrl: handoff.returnUrl } : {}),
      completionToken: handoff.completionToken,
      expiresAt: handoff.expiresAt,
    },
    materials,
  });
  response.headers.set('cache-control', 'no-store');
  return response;
}
