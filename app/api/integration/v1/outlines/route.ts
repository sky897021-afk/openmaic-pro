/**
 * POST /api/integration/v1/outlines
 *
 * Platform-facing outline generation for the classic course pipeline.
 *
 * The platform may send the original PDF/DOCX/image/etc. files directly as
 * multipart data. OpenMAIC extracts and stores them with the same material
 * pipeline used by module 2, generates the outline, and returns opaque
 * `materialIds` that `/courses` can reuse after the teacher edits the plan.
 *
 * The legacy JSON request with platform-extracted material text remains
 * supported.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { nanoid } from 'nanoid';

import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  generateClassicOutlines,
  type GenerateClassroomInput,
} from '@/lib/server/classroom-generation';
import {
  isIntegrationConfigured,
  verifyIntegrationRequestBytes,
  verifyIntegrationUploadAuth,
} from '@/lib/server/integration/auth';
import {
  MAX_MATERIAL_TEXT_CHARS,
  parseOutlineRequest,
  type OutlineRequest,
} from '@/lib/server/integration/contract';
import {
  buildIntegrationMaterialContext,
  readIntegrationMaterialContext,
} from '@/lib/server/integration/material-context';
import { extractIntegrationMaterial } from '@/lib/server/integration/material-extract';
import {
  saveIntegrationMaterial,
  type IntegrationMaterialRecord,
} from '@/lib/server/integration/materials';

export const runtime = 'nodejs';
// File extraction plus outline generation can be slow for scanned documents.
export const maxDuration = 300;

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const OPTION_FIELDS = [
  'enableWebSearch',
  'enableImageGeneration',
  'enableVideoGeneration',
] as const;

const log = createLogger('IntegrationOutlines');

interface OutlineMaterialSummary {
  materialId?: string;
  fileName: string;
  kind?: string;
  size?: number;
  chars?: number;
  imageCount?: number;
  pageCount?: number;
  layoutPageCount?: number;
  parser?: string;
  error?: string;
}

interface MultipartMetadataResult {
  ok: boolean;
  body?: Record<string, unknown>;
  message?: string;
}

function summarizeMaterial(record: IntegrationMaterialRecord): OutlineMaterialSummary {
  return {
    materialId: record.id,
    fileName: record.fileName,
    kind: record.kind,
    size: record.size,
    chars: record.text.length,
    imageCount: record.images.length,
    pageCount: record.layout.pageCount ?? 0,
    layoutPageCount: record.layout.pages?.length ?? 0,
    parser: record.parser,
  };
}

function safeFileName(name: string): string {
  return name.split(/[\\/]/).pop()?.trim() || 'material';
}

function isFileValue(value: FormDataEntryValue): value is File {
  return typeof value !== 'string' && typeof value.arrayBuffer === 'function';
}

function formString(form: FormData, field: string): string | undefined {
  const value = form.get(field);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseMultipartMetadata(form: FormData): MultipartMetadataResult {
  let options: Record<string, unknown> = {};
  const rawOptions = formString(form, 'options');
  if (rawOptions) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawOptions);
    } catch {
      return { ok: false, message: 'options must be valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'options must be a JSON object' };
    }
    options = parsed as Record<string, unknown>;
  }

  for (const field of OPTION_FIELDS) {
    const raw = formString(form, field);
    if (raw === undefined) continue;
    if (raw !== 'true' && raw !== 'false') {
      return { ok: false, message: `${field} must be "true" or "false"` };
    }
    options[field] = raw === 'true';
  }

  return {
    ok: true,
    body: {
      tenantId: formString(form, 'tenantId') ?? '',
      requirement: formString(form, 'requirement') ?? '',
      ...(formString(form, 'externalCourseId')
        ? { externalCourseId: formString(form, 'externalCourseId') }
        : {}),
      ...(formString(form, 'externalChapterId')
        ? { externalChapterId: formString(form, 'externalChapterId') }
        : {}),
      options,
    },
  };
}

function buildInput(
  request: OutlineRequest,
  pdfContent: GenerateClassroomInput['pdfContent'],
): GenerateClassroomInput {
  const { requirement, options } = request;
  return {
    requirement,
    ...(pdfContent ? { pdfContent } : {}),
    ...(options.enableWebSearch !== undefined ? { enableWebSearch: options.enableWebSearch } : {}),
    ...(options.enableImageGeneration !== undefined
      ? { enableImageGeneration: options.enableImageGeneration }
      : {}),
    ...(options.enableVideoGeneration !== undefined
      ? { enableVideoGeneration: options.enableVideoGeneration }
      : {}),
  };
}

function capMaterialsText(text: string): { text: string; truncated: boolean } {
  return {
    text: text.slice(0, MAX_MATERIAL_TEXT_CHARS),
    truncated: text.length > MAX_MATERIAL_TEXT_CHARS,
  };
}

async function generateAndRespond(
  request: OutlineRequest,
  pdfContent: GenerateClassroomInput['pdfContent'],
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const { tenantId, externalCourseId } = request;
  try {
    const plan = await generateClassicOutlines(buildInput(request, pdfContent));
    return apiSuccess({
      outlineId: `ol_${nanoid(12)}`,
      courseTitle: plan.courseTitle || plan.outlines[0]?.title || '',
      languageDirective: plan.languageDirective,
      outlines: plan.outlines,
      ...extra,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      `Outline generation failed [tenant=${tenantId}, course=${externalCourseId ?? 'unknown'}]:`,
      error,
    );
    return apiError('GENERATION_FAILED', 502, 'Outline generation failed', message);
  }
}

async function handleMultipart(req: NextRequest, rawBody: Buffer): Promise<Response> {
  const auth = verifyIntegrationUploadAuth(req, rawBody);
  if (!auth.ok) return apiError('UNAUTHENTICATED', auth.status, auth.message);

  let form: FormData;
  try {
    form = await new Request(req.url, {
      method: 'POST',
      headers: req.headers,
      body: new Uint8Array(rawBody),
    }).formData();
  } catch {
    return apiError(
      'INVALID_REQUEST',
      400,
      'expected multipart/form-data with one or more files under "files"',
    );
  }

  const metadata = parseMultipartMetadata(form);
  if (!metadata.ok || !metadata.body) {
    return apiError('INVALID_REQUEST', 400, metadata.message ?? 'invalid multipart fields');
  }

  const parsed = parseOutlineRequest(metadata.body);
  if (!parsed.ok) return apiError('INVALID_REQUEST', 400, parsed.message);
  const request = parsed.value;

  const files: File[] = [];
  for (const field of ['files', 'file']) {
    for (const value of form.getAll(field)) {
      if (isFileValue(value)) files.push(value);
    }
  }
  if (files.length === 0) {
    return apiError(
      'MISSING_REQUIRED_FIELD',
      400,
      'attach at least one file under the "files" field',
    );
  }
  if (files.length > MAX_FILES) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `cannot generate an outline from more than ${MAX_FILES} files at once`,
    );
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return apiError(
      'INVALID_REQUEST',
      413,
      `total upload exceeds ${MAX_TOTAL_BYTES / 1024 / 1024} MB`,
    );
  }

  const summaries: OutlineMaterialSummary[] = [];
  const storedRecords: IntegrationMaterialRecord[] = [];
  const materialIds: string[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const fileName = safeFileName(file.name);
    if (file.size === 0) {
      summaries.push({ fileName, error: 'the file is empty' });
      continue;
    }
    if (file.size > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
      summaries.push({
        fileName,
        error: `file exceeds ${MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024} MB`,
      });
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const extracted = await extractIntegrationMaterial({
        buffer,
        fileName,
        mimeType: file.type,
      });
      if (!extracted.text.trim() && extracted.images.length === 0) {
        throw new Error('the file produced no readable text or images');
      }

      const stored = await saveIntegrationMaterial(
        {
          tenantId: request.tenantId,
          fileName,
          mimeType: extracted.mimeType,
          kind: extracted.kind,
          size: buffer.byteLength,
          parser: extracted.parser,
          text: extracted.text,
          images: extracted.images,
          layout: extracted.layout,
        },
        { bytes: buffer, fileName },
      );

      materialIds.push(stored.id);
      storedRecords.push(stored);
      summaries.push(summarizeMaterial(stored));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Outline material extraction failed for "${fileName}":`, error);
      summaries.push({ fileName, error: message });
    }
  }

  const failed = summaries.filter((summary) => summary.error).length;
  if (failed > 0) {
    warnings.push(`${failed}/${summaries.length} uploaded file(s) could not be read`);
  }

  const context = buildIntegrationMaterialContext(storedRecords);
  if (!context.text.trim() && context.pdfImages.length === 0) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'none of the uploaded files produced readable text or images',
      summaries
        .filter((summary) => summary.error)
        .map((summary) => `${summary.fileName}: ${summary.error}`)
        .join('; '),
    );
  }

  const capped = capMaterialsText(context.text);
  if (capped.truncated) {
    warnings.push(`material text was truncated to ${MAX_MATERIAL_TEXT_CHARS} characters`);
  }

  log.info(
    `Prepared ${materialIds.length}/${summaries.length} outline material(s) ` +
      `[bytes=${totalBytes}, tenant=${request.tenantId}]`,
  );

  return generateAndRespond(
    request,
    {
      text: capped.text,
      images: context.images,
      ...(context.pdfImages.length ? { pdfImages: context.pdfImages } : {}),
      ...(Object.keys(context.imageMapping).length
        ? { imageMapping: context.imageMapping }
        : {}),
    },
    {
      materialIds,
      materials: summaries,
      ...(warnings.length ? { warnings } : {}),
    },
  );
}

async function handleJson(req: NextRequest, rawBody: Buffer): Promise<Response> {
  const auth = verifyIntegrationRequestBytes(req, rawBody);
  if (!auth.ok) return apiError('UNAUTHENTICATED', auth.status, auth.message);

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }

  const parsed = parseOutlineRequest(body);
  if (!parsed.ok) return apiError('INVALID_REQUEST', 400, parsed.message);
  const request = parsed.value;

  let pdfContent: GenerateClassroomInput['pdfContent'] = request.materialsText
    ? { text: request.materialsText, images: [] }
    : undefined;
  let materials: OutlineMaterialSummary[] | undefined;
  const warnings: string[] = [];

  if (request.materialIds?.length) {
    const context = await readIntegrationMaterialContext({
      tenantId: request.tenantId,
      materialIds: request.materialIds,
    });
    if (!context.ok) return apiError('INVALID_REQUEST', 400, context.message);
    const capped = capMaterialsText(context.value.text);
    pdfContent =
      capped.text.trim() || context.value.pdfImages.length
        ? {
            text: capped.text,
            images: context.value.images,
            ...(context.value.pdfImages.length
              ? { pdfImages: context.value.pdfImages }
              : {}),
            ...(Object.keys(context.value.imageMapping).length
              ? { imageMapping: context.value.imageMapping }
              : {}),
          }
        : undefined;
    if (context.value.textTruncated) {
      warnings.push(`material text was truncated to ${MAX_MATERIAL_TEXT_CHARS} characters`);
    }
    materials = context.value.records.map(summarizeMaterial);
  }

  return generateAndRespond(request, pdfContent, {
    ...(request.materialIds?.length ? { materialIds: request.materialIds } : {}),
    ...(materials ? { materials } : {}),
    ...(warnings.length ? { warnings } : {}),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isIntegrationConfigured()) return new NextResponse('Not found', { status: 404 });

  // Read once: multipart HMAC authentication signs the exact bytes.
  const rawBody = Buffer.from(await req.arrayBuffer());
  const contentType = req.headers.get('content-type')?.toLowerCase() ?? '';

  if (contentType.startsWith('multipart/form-data')) {
    return handleMultipart(req, rawBody);
  }
  if (contentType.startsWith('application/json') || !contentType) {
    return handleJson(req, rawBody);
  }

  return apiError(
    'INVALID_REQUEST',
    400,
    'expected application/json or multipart/form-data',
  );
}
