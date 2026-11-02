/**
 * POST /api/integration/v1/materials
 *
 * Module 2's material upload: the platform sends the original source files
 * server-to-server, and OpenMAIC keeps them (plus text, embedded images and a
 * layout digest) under an opaque `materialId`. A later handoff references that
 * id when the browser jumps to `/game`.
 *
 * Authentication is HMAC over the raw multipart bytes, or
 * `Authorization: Bearer <INTEGRATION_SHARED_SECRET>`.
 */
import { type NextRequest, NextResponse } from 'next/server';

import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isIntegrationConfigured,
  verifyIntegrationUploadAuth,
} from '@/lib/server/integration/auth';
import { MAX_TENANT_CHARS } from '@/lib/server/integration/contract';
import { extractIntegrationMaterial } from '@/lib/server/integration/material-extract';
import { saveIntegrationMaterial } from '@/lib/server/integration/materials';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

const log = createLogger('IntegrationMaterials');

function safeFileName(name: string): string {
  return name.split(/[\\/]/).pop()?.trim() || 'material';
}

function isFileValue(value: FormDataEntryValue): value is File {
  return typeof value !== 'string' && typeof value.arrayBuffer === 'function';
}

interface MaterialSummary {
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

export async function POST(req: NextRequest) {
  if (!isIntegrationConfigured()) return new NextResponse('Not found', { status: 404 });

  const rawBody = Buffer.from(await req.arrayBuffer());
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

  const rawTenantId = form.get('tenantId');
  const tenantId = typeof rawTenantId === 'string' ? rawTenantId.trim() : '';
  if (!tenantId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'tenantId is required');
  }
  if (tenantId.length > MAX_TENANT_CHARS) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `tenantId must be at most ${MAX_TENANT_CHARS} characters`,
    );
  }

  const files: File[] = [];
  for (const field of ['files', 'file']) {
    for (const value of form.getAll(field)) {
      if (isFileValue(value)) files.push(value);
    }
  }

  if (files.length === 0) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'attach at least one file under "files"');
  }
  if (files.length > MAX_FILES) {
    return apiError('INVALID_REQUEST', 400, `cannot store more than ${MAX_FILES} files at once`);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return apiError(
      'INVALID_REQUEST',
      413,
      `total upload exceeds ${MAX_TOTAL_BYTES / 1024 / 1024} MB`,
    );
  }

  const materials: MaterialSummary[] = [];
  for (const file of files) {
    const fileName = safeFileName(file.name);
    if (file.size === 0) {
      materials.push({ fileName, error: 'the file is empty' });
      continue;
    }
    if (file.size > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
      materials.push({
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
      const stored = await saveIntegrationMaterial(
        {
          tenantId,
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

      materials.push({
        materialId: stored.id,
        fileName,
        kind: stored.kind,
        size: stored.size,
        chars: stored.text.length,
        imageCount: stored.images.length,
        pageCount: stored.layout.pageCount ?? 0,
        layoutPageCount: stored.layout.pages?.length ?? 0,
        parser: stored.parser,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Material extraction failed for "${fileName}":`, error);
      materials.push({ fileName, error: message });
    }
  }

  const stored = materials.filter((material) => material.materialId).length;
  log.info(
    `Stored ${stored}/${materials.length} material(s) [bytes=${totalBytes}, tenant=${tenantId}]`,
  );

  return apiSuccess({ materials });
}
