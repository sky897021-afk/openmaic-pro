/**
 * GET /api/integration/v1/courses/jobs/[jobId]
 *
 * Poll one integration generation job. The platform polls this until `done`,
 * then stores `result.stageId` / `result.classroomUrl` against its chapter.
 *
 * Only ids created by this API (`int_<hex>`) are accepted, so the endpoint
 * cannot be used to enumerate ordinary classroom jobs.
 */
import type { NextRequest } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isIntegrationConfigured,
  isIntegrationJobId,
  verifyIntegrationRequest,
} from '@/lib/server/integration/auth';
import { readClassroomGenerationJob } from '@/lib/server/classroom-job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  if (!isIntegrationConfigured()) return new Response('Not found', { status: 404 });

  // GET carries no body; the signature is over the empty string.
  const rawBody = await req.text();
  const auth = verifyIntegrationRequest(req, rawBody);
  if (!auth.ok) return apiError('UNAUTHENTICATED', auth.status, auth.message);

  const { jobId } = await context.params;
  if (!isIntegrationJobId(jobId)) {
    return apiError('INVALID_REQUEST', 400, 'invalid integration job id');
  }

  const job = await readClassroomGenerationJob(jobId);
  if (!job) return apiError('INVALID_REQUEST', 404, 'integration job not found');

  return apiSuccess({
    jobId: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    message: job.message,
    scenesGenerated: job.scenesGenerated,
    ...(job.totalScenes !== undefined ? { totalScenes: job.totalScenes } : {}),
    done: job.status === 'succeeded' || job.status === 'failed',
    ...(job.result
      ? {
          result: {
            stageId: job.result.classroomId,
            classroomUrl: job.result.url,
            scenesCount: job.result.scenesCount,
            ...(job.result.warning ? { warning: job.result.warning } : {}),
          },
        }
      : {}),
    ...(job.error ? { error: job.error } : {}),
  });
}
