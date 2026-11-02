/**
 * Candidate fallback for raw-file extraction.
 *
 * The whole reason the integration endpoint exists is that the first extractor
 * for a MIME is not necessarily a configured one. These tests pin the rule:
 * try every compatible extractor, skip failures and empty output, return the
 * first non-empty text, and report every reason if none works.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  DocumentArtifact,
  DocumentExtractorProvider,
  MediaArtifact,
  MediaExtractorProvider,
} from '@/lib/document/types';
import { extractIntegrationFile, MAX_EXTRACTED_TEXT_CHARS } from '@/lib/server/integration/extract';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PNG = 'image/png';

function documentArtifact(
  text: string,
  diagnostics: DocumentArtifact['diagnostics'] = [],
): DocumentArtifact {
  return {
    metadata: {},
    blocks: [{ id: 'block-1', type: 'text', text }],
    assets: [],
    diagnostics,
  };
}

function docProvider(
  id: string,
  mimeType: string,
  extract: DocumentExtractorProvider['extract'],
): DocumentExtractorProvider {
  return {
    id,
    displayName: id,
    version: '1',
    supportedMimeTypes: [mimeType],
    capabilities: {
      text: true,
      images: false,
      tables: false,
      formulas: false,
      layout: false,
      ocr: false,
      async: false,
    },
    extract,
  };
}

function mediaProvider(
  id: string,
  mimeType: string,
  extract: MediaExtractorProvider['extract'],
  availability?: MediaExtractorProvider['availability'],
): MediaExtractorProvider {
  return {
    id,
    displayName: id,
    version: '1',
    supportedMimeTypes: [mimeType],
    capabilities: {
      transcript: true,
      keyframes: false,
      synopsis: false,
      ocr: false,
      async: false,
    },
    ...(availability ? { availability } : {}),
    extract,
  };
}

const deps = {
  resolveApiKey: () => undefined,
  resolveBaseUrl: () => undefined,
};

describe('extractIntegrationFile — document fallback', () => {
  it('skips an extractor that throws and uses the next one', async () => {
    const first = vi.fn().mockRejectedValue(new Error('credentials missing'));
    const second = vi.fn().mockResolvedValue(documentArtifact('DOCX 正文'));

    const result = await extractIntegrationFile(
      { buffer: Buffer.from('bytes'), fileName: 'lesson.docx', mimeType: DOCX },
      {
        ...deps,
        documentProviders: [
          docProvider('mineru', DOCX, first),
          docProvider('local-document', DOCX, second),
        ],
      },
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: 'DOCX 正文', parser: 'local-document' });
    expect(result.error).toBeUndefined();
  });

  it('skips an extractor that returns no text', async () => {
    const first = vi.fn().mockResolvedValue(documentArtifact('   '));
    const second = vi.fn().mockResolvedValue(documentArtifact('实际内容'));

    const result = await extractIntegrationFile(
      { buffer: Buffer.from('bytes'), fileName: 'lesson.docx', mimeType: DOCX },
      {
        ...deps,
        documentProviders: [docProvider('empty', DOCX, first), docProvider('real', DOCX, second)],
      },
    );

    expect(result).toMatchObject({ text: '实际内容', parser: 'real' });
  });

  it('reports every reason when no extractor can read the file', async () => {
    const result = await extractIntegrationFile(
      { buffer: Buffer.from('bytes'), fileName: 'lesson.docx', mimeType: DOCX },
      {
        ...deps,
        documentProviders: [
          docProvider('mineru', DOCX, vi.fn().mockRejectedValue(new Error('no base URL'))),
          docProvider('alidocmind', DOCX, vi.fn().mockRejectedValue(new Error('no credentials'))),
        ],
      },
    );

    expect(result.text).toBe('');
    expect(result.error).toContain('mineru: no base URL');
    expect(result.error).toContain('alidocmind: no credentials');
  });

  it('reports an unsupported MIME type', async () => {
    const result = await extractIntegrationFile(
      { buffer: Buffer.from('bytes'), fileName: 'file.unknown', mimeType: 'application/x-unknown' },
      { ...deps, documentProviders: [] },
    );

    expect(result.error).toContain('no extractor supports');
  });

  it('keeps provider diagnostics with the successful result', async () => {
    const provider = docProvider(
      'vision-ocr',
      PNG,
      vi
        .fn()
        .mockResolvedValue(
          documentArtifact('图片里的字', [
            { severity: 'warning', message: 'page 1 produced no transcription' },
          ]),
        ),
    );

    const result = await extractIntegrationFile(
      { buffer: Buffer.from('bytes'), fileName: 'scan.png', mimeType: PNG },
      { ...deps, documentProviders: [provider] },
    );

    expect(result.diagnostics).toEqual(['vision-ocr: page 1 produced no transcription']);
  });

  it('truncates oversized text to the contract limit and says so', async () => {
    const provider = docProvider(
      'large',
      DOCX,
      vi.fn().mockResolvedValue(documentArtifact('x'.repeat(MAX_EXTRACTED_TEXT_CHARS + 10))),
    );

    const result = await extractIntegrationFile(
      { buffer: Buffer.from('bytes'), fileName: 'large.docx', mimeType: DOCX },
      { ...deps, documentProviders: [provider] },
    );

    expect(result.text).toHaveLength(MAX_EXTRACTED_TEXT_CHARS);
    expect(result.diagnostics?.[0]).toContain('truncated');
  });
});

describe('extractIntegrationFile — media fallback', () => {
  it('skips an unavailable media extractor and uses the next one', async () => {
    const unavailable = mediaProvider(
      'local-ffmpeg',
      'video/mp4',
      vi.fn(),
      vi.fn().mockResolvedValue({ available: false, reason: 'ffmpeg is unavailable' }),
    );
    const working = mediaProvider(
      'alidocmind',
      'video/mp4',
      vi.fn().mockResolvedValue({
        metadata: {},
        transcript: [{ id: 't1', startMs: 0, endMs: 1000, text: '视频转写内容' }],
      } satisfies MediaArtifact),
    );

    const result = await extractIntegrationFile(
      { buffer: Buffer.from('bytes'), fileName: 'demo.mp4', mimeType: 'video/mp4' },
      { ...deps, mediaProviders: [unavailable, working] },
    );

    expect(unavailable.extract).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: '视频转写内容', parser: 'alidocmind' });
  });

  it('reports why every media extractor was unavailable', async () => {
    const result = await extractIntegrationFile(
      { buffer: Buffer.from('bytes'), fileName: 'demo.mp4', mimeType: 'video/mp4' },
      {
        ...deps,
        mediaProviders: [
          mediaProvider(
            'local-ffmpeg',
            'video/mp4',
            vi.fn(),
            vi.fn().mockResolvedValue({ available: false, reason: 'ffmpeg is unavailable' }),
          ),
        ],
      },
    );

    expect(result.error).toContain('local-ffmpeg: ffmpeg is unavailable');
  });
});
