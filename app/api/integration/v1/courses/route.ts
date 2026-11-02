/**
 * POST /api/integration/v1/courses
 *
 * Generate a classic (完整课程) course from a teacher-approved outline.
 *
 * The outline travels IN the request (`outlines`), so the job does not
 * regenerate it: the pages the teacher confirmed are the pages that get built.
 * The job itself is the existing `generate-classroom` pipeline — this route is
 * a thin, authenticated front door for it.
 *
 * `Idempotency-Key` is required. The key is mapped to a stable job id, and a
 * repeated request returns the original job instead of starting a second
 * course.
 */
import { after, type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  isIntegrationConfigured,
  integrationBaseUrl,
  integrationJobId,
  isValidIdempotencyKey,
  verifyIntegrationRequest,
} from '@/lib/server/integration/auth';
import { parseCourseRequest } from '@/lib/server/integration/contract';
import { readIntegrationMaterialContext } from '@/lib/server/integration/material-context';
import {
  createClassroomGenerationJobIfAbsent,
  readClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';

export const runtime = 'nodejs';
// The handler only queues: the job runs after the response is sent.
export const maxDuration = 30;

const log = createLogger('IntegrationCourses');

export async function POST(req: NextRequest) {
  if (!isIntegrationConfigured()) return new Response('Not found', { status: 404 });

  const rawBody = await req.text();
  const auth = verifyIntegrationRequest(req, rawBody);
  if (!auth.ok) {
    return apiError('UNAUTHENTICATED', auth.status, auth.message);
  }

  const idempotencyKey = req.headers.get('idempotency-key');
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return apiError(
      'MISSING_REQUIRED_FIELD',
      400,
      'Idempotency-Key header is required (1-200 characters)',
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }

  const parsed = parseCourseRequest(body);
  if (!parsed.ok) return apiError('INVALID_REQUEST', 400, parsed.message);

  const {
    tenantId,
    requirement,
    materialIds,
    materialsText,
    outlines,
    courseTitle,
    languageDirective,
    options,
    externalCourseId,
  } = parsed.value;

  const jobId = integrationJobId(tenantId, idempotencyKey);
  const baseUrl = integrationBaseUrl(req);
  const pollUrl = `${baseUrl}/api/integration/v1/courses/jobs/${jobId}`;

  const existing = await readClassroomGenerationJob(jobId);
  if (existing) {
    log.info(
      `Reusing integration job ${jobId} [tenant=${tenantId}, course=${
        externalCourseId ?? 'unknown'
      }, status=${existing.status}]`,
    );
    return apiSuccess(
      {
        jobId,
        status: existing.status,
        pollUrl,
        reused: true,
      },
      202,
    );
  }

  let pdfContent: GenerateClassroomInput['pdfContent'];
  if (materialIds?.length) {
    const context = await readIntegrationMaterialContext({ tenantId, materialIds });
    if (!context.ok) {
      return apiError('INVALID_REQUEST', 400, 'one or more materialIds are invalid', context.message);
    }
    pdfContent = {
      text: context.value.text,
      images: context.value.images,
      ...(context.value.pdfImages.length ? { pdfImages: context.value.pdfImages } : {}),
      ...(Object.keys(context.value.imageMapping).length
        ? { imageMapping: context.value.imageMapping }
        : {}),
    };
  } else if (materialsText) {
    pdfContent = { text: materialsText, images: [] };
  }

  const input: GenerateClassroomInput = {
    requirement,
    ...(pdfContent ? { pdfContent } : {}),
    outlines,
    ...(courseTitle ? { courseTitle } : {}),
    ...(languageDirective ? { languageDirective } : {}),
    // Module 1 ships generation + link only; narration is opt-in later.
    enableTTS: false,
    ...(options.enableWebSearch !== undefined ? { enableWebSearch: options.enableWebSearch } : {}),
    ...(options.enableImageGeneration !== undefined
      ? { enableImageGeneration: options.enableImageGeneration }
      : {}),
    ...(options.enableVideoGeneration !== undefined
      ? { enableVideoGeneration: options.enableVideoGeneration }
      : {}),
  };

  const creation = await createClassroomGenerationJobIfAbsent(jobId, input);
  if (!creation.created) {
    log.info(
      `Reusing integration job ${jobId} after concurrent create [tenant=${tenantId}, status=${
        creation.job.status
      }]`,
    );
    return apiSuccess(
      {
        jobId,
        status: creation.job.status,
        pollUrl,
        reused: true,
      },
      202,
    );
  }

  after(() => runClassroomGenerationJob(jobId, input, baseUrl));

  log.info(
    `Queued integration job ${jobId} [tenant=${tenantId}, course=${
      externalCourseId ?? 'unknown'
    }, pages=${outlines.length}]`,
  );

  return apiSuccess(
    {
      jobId,
      status: creation.job.status,
      pollUrl,
      reused: false,
    },
    202,
  );
}
