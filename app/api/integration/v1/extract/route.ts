/**
 * POST /api/integration/v1/extract
 *
 * Let the platform upload raw source files and receive extracted text, so it
 * does not have to know which parser can read a `.docx`, a scanned PDF or an
 * image.
 *
 * One file failing is not fatal: the response carries a per-file `error` and
 * the rest of the batch is still read. The platform then feeds the `text`
 * values into `/outlines` and `/courses` exactly as before.
 *
 * Authentication accepts the HMAC headers (over the raw multipart bytes) or,
 * because signing a multipart body is awkward in many HTTP clients,
 * `Authorization: Bearer <shared secret>`.
 */
import { type NextRequest, NextResponse } from 'next/server';

import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isIntegrationConfigured,
  verifyIntegrationUploadAuth,
} from '@/lib/server/integration/auth';
import {
  extractIntegrationFile,
  type IntegrationExtractionResult,
} from '@/lib/server/integration/extract';

export const runtime = 'nodejs';
// Large PDFs and image OCR can take a while.
export const maxDuration = 300;

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

const log = createLogger('IntegrationExtract');

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim();
  return base || 'upload';
}

function isFileValue(value: FormDataEntryValue): value is File {
  return typeof value !== 'string' && typeof value.arrayBuffer === 'function';
}

export async function POST(req: NextRequest) {
  if (!isIntegrationConfigured()) return new NextResponse('Not found', { status: 404 });

  // Read once: the bytes are needed both for HMAC verification and for parsing.
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
    return apiError('INVALID_REQUEST', 400, `cannot extract more than ${MAX_FILES} files at once`);
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return apiError(
      'INVALID_REQUEST',
      413,
      `total upload exceeds ${MAX_TOTAL_BYTES / 1024 / 1024} MB`,
    );
  }

  const materials: IntegrationExtractionResult[] = [];
  for (const file of files) {
    const fileName = safeFileName(file.name);
    if (file.size === 0) {
      materials.push({
        fileName,
        mimeType: file.type,
        kind: 'file',
        text: '',
        parser: '',
        error: 'the file is empty',
      });
      continue;
    }
    if (file.size > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
      materials.push({
        fileName,
        mimeType: file.type,
        kind: 'file',
        text: '',
        parser: '',
        error: `file exceeds ${MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024} MB`,
      });
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      materials.push(
        await extractIntegrationFile({
          buffer,
          fileName,
          mimeType: file.type,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Extraction failed for "${fileName}":`, error);
      materials.push({
        fileName,
        mimeType: file.type,
        kind: 'file',
        text: '',
        parser: '',
        error: message,
      });
    }
  }

  const succeeded = materials.filter((material) => !material.error).length;
  log.info(`Extracted ${succeeded}/${materials.length} uploaded file(s) [bytes=${totalBytes}]`);

  return apiSuccess({ materials });
}
