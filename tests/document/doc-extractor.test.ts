/**
 * Local legacy DOC extraction.
 *
 * The OLE container parser itself is `word-extractor`; these tests pin the
 * wrapper contract (body only, empty bodies fail loudly) and the
 * local-document dispatch, with the parser stubbed.
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ extract: vi.fn() }));

vi.mock('word-extractor', () => ({
  default: class {
    extract(input: unknown) {
      return mocks.extract(input);
    }
  },
}));

import { extractDocText } from '@/lib/document/extractors/doc';
import { officeDocumentExtractorProvider } from '@/lib/document/extractors/office-document';
import { DOCUMENT_MIME_TYPES } from '@/lib/document/mime';

describe('extractDocText', () => {
  it('returns the document body', async () => {
    mocks.extract.mockResolvedValue({ getBody: () => '  DOC 正文  ' });

    await expect(extractDocText(Buffer.from('ole'))).resolves.toBe('DOC 正文');
  });

  it('fails loudly when the body is empty', async () => {
    mocks.extract.mockResolvedValue({ getBody: () => '   ' });

    await expect(extractDocText(Buffer.from('ole'))).rejects.toThrow(/no readable text/);
  });
});

describe('local-document provider — doc', () => {
  it('dispatches .doc by MIME', async () => {
    mocks.extract.mockResolvedValue({ getBody: () => '老式 Word 正文' });

    const artifact = await officeDocumentExtractorProvider.extract({
      buffer: Buffer.from('ole'),
      fileName: 'manual.doc',
      fileSize: 3,
      mimeType: DOCUMENT_MIME_TYPES.doc,
      config: { providerId: 'local-document' },
    });

    expect(artifact.blocks[0]).toMatchObject({ type: 'text', text: '老式 Word 正文' });
  });
});
