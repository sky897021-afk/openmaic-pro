/**
 * Raw-file extraction for the integration API.
 *
 * The platform may upload source files instead of extracting them itself. For
 * each file this tries EVERY extractor that advertises the MIME type, in
 * registry order, and stops at the first one that produces text.
 *
 * That fallback matters: the document registry is ordered by preference, not
 * by configuration. For an image, MinerU comes before `vision-ocr`; MinerU is
 * unconfigured on most deployments, so a "pick the first provider" path would
 * fail even though `vision-ocr` could have read the file. A provider that
 * throws or returns empty text is therefore skipped, never fatal.
 *
 * SERVER-ONLY: it reaches provider implementations (sharp, @alicloud/*,
 * child_process, …) and the model-resolution stack.
 */
import type {
  DocumentArtifact,
  DocumentExtractorConfig,
  DocumentExtractorProvider,
  MediaArtifact,
  MediaExtractorProvider,
} from '@/lib/document/types';
import { getDocumentExtractorProviders } from '@/lib/document/extractors/registry';
import { getMediaExtractorProviders } from '@/lib/document/extractors/media-registry';
import {
  MEDIA_PROVIDER_SUPPORTED_MIME_TYPES,
  normalizeDocumentMimeType,
} from '@/lib/document/mime';
import { resolvePDFApiKey, resolvePDFBaseUrl } from '@/lib/server/provider-config';

/**
 * Matches the integration contract's material-text cap. A longer extraction is
 * truncated here rather than handed to `/outlines`, which would reject the
 * whole request.
 */
export const MAX_EXTRACTED_TEXT_CHARS = 200_000;

const MEDIA_MIMES = new Set(Object.values(MEDIA_PROVIDER_SUPPORTED_MIME_TYPES).flat());

export interface IntegrationExtractionResult {
  fileName: string;
  mimeType: string;
  /** Short format label for the platform (`docx`, `pdf`, `video`, …). */
  kind: string;
  text: string;
  /** Extractor that produced the text; empty on failure. */
  parser: string;
  diagnostics?: string[];
  error?: string;
}

export interface IntegrationExtractorDeps {
  /** Injectable for tests. */
  documentProviders?: DocumentExtractorProvider[];
  mediaProviders?: MediaExtractorProvider[];
  resolveApiKey?: (providerId: string) => string | undefined;
  resolveBaseUrl?: (providerId: string) => string | undefined;
}

function kindFor(fileName: string, mimeType: string): string {
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
  return extension || mimeType.split('/').pop() || 'file';
}

function artifactText(artifact: DocumentArtifact): string {
  return artifact.blocks
    .filter((block) => block.type === 'text' || block.type === 'markdown')
    .map((block) => block.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n\n');
}

function mediaArtifactText(artifact: MediaArtifact): string {
  const parts: string[] = [];
  if (artifact.transcript?.length) {
    const lines = artifact.transcript
      .map((segment) => segment.text?.trim())
      .filter((text): text is string => Boolean(text));
    if (lines.length) parts.push(lines.join('\n'));
  }
  if (artifact.keyframes?.length) {
    const lines = artifact.keyframes
      .map((frame) => (frame.description || frame.ocrText || '').trim())
      .filter(Boolean);
    if (lines.length) parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

function capText(text: string, diagnostics: string[]): string {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text;
  diagnostics.push(
    `text truncated to ${MAX_EXTRACTED_TEXT_CHARS} characters (source produced ${text.length})`,
  );
  return text.slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

/**
 * Extract one file, trying every compatible extractor until one returns text.
 *
 * Never throws for an unreadable file: the failure is reported on that file so
 * one bad upload does not sink the rest of the batch.
 */
export async function extractIntegrationFile(
  input: { buffer: Buffer; fileName: string; mimeType?: string },
  deps: IntegrationExtractorDeps = {},
): Promise<IntegrationExtractionResult> {
  const fileName = input.fileName || 'upload';
  const normalizedMime = normalizeDocumentMimeType({
    mimeType: input.mimeType,
    fileName,
  });
  const mimeType = (normalizedMime || input.mimeType || '').split(';')[0].trim().toLowerCase();
  const base = { fileName, mimeType, kind: kindFor(fileName, mimeType) };

  if (!mimeType) {
    return { ...base, text: '', parser: '', error: 'could not determine the file type' };
  }

  const resolveApiKey = deps.resolveApiKey ?? resolvePDFApiKey;
  const resolveBaseUrl = deps.resolveBaseUrl ?? resolvePDFBaseUrl;
  const configFor = (providerId: string): DocumentExtractorConfig => ({
    providerId,
    apiKey: resolveApiKey(providerId) || undefined,
    baseUrl: resolveBaseUrl(providerId),
    allowEnvFallback: true,
    managed: true,
  });

  const errors: string[] = [];
  const diagnostics: string[] = [];
  const isMedia = MEDIA_MIMES.has(mimeType);

  if (isMedia) {
    const providers =
      deps.mediaProviders ??
      getMediaExtractorProviders().filter((provider) =>
        provider.supportedMimeTypes.includes(mimeType),
      );
    for (const provider of providers) {
      if (!provider.supportedMimeTypes.includes(mimeType)) continue;
      const extractorInput = {
        buffer: input.buffer,
        fileName,
        fileSize: input.buffer.byteLength,
        mimeType,
        config: configFor(provider.id),
      };
      try {
        const availability = await provider.availability?.(extractorInput);
        if (availability && !availability.available) {
          errors.push(`${provider.id}: ${availability.reason ?? 'unavailable'}`);
          continue;
        }
        const artifact = await provider.extract(extractorInput);
        const text = mediaArtifactText(artifact).trim();
        if (text) {
          return {
            ...base,
            text: capText(text, diagnostics),
            parser: provider.id,
            ...(diagnostics.length ? { diagnostics } : {}),
          };
        }
        errors.push(`${provider.id}: produced no text`);
      } catch (error) {
        errors.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    const providers =
      deps.documentProviders ??
      getDocumentExtractorProviders().filter(
        (provider) => provider.supportedMimeTypes.includes(mimeType) && provider.capabilities.text,
      );
    for (const provider of providers) {
      if (!provider.supportedMimeTypes.includes(mimeType) || !provider.capabilities.text) continue;
      const extractorInput = {
        buffer: input.buffer,
        fileName,
        fileSize: input.buffer.byteLength,
        mimeType,
        config: configFor(provider.id),
      };
      try {
        const artifact = await provider.extract(extractorInput);
        const text = artifactText(artifact).trim();
        for (const diagnostic of artifact.diagnostics ?? []) {
          if (diagnostic.message) diagnostics.push(`${provider.id}: ${diagnostic.message}`);
        }
        if (text) {
          return {
            ...base,
            text: capText(text, diagnostics),
            parser: provider.id,
            ...(diagnostics.length ? { diagnostics } : {}),
          };
        }
        errors.push(`${provider.id}: produced no text`);
      } catch (error) {
        errors.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    ...base,
    text: '',
    parser: '',
    ...(diagnostics.length ? { diagnostics } : {}),
    error:
      errors.length > 0
        ? `no extractor could read this file (${errors.join('; ')})`
        : `no extractor supports ${mimeType}`,
  };
}
