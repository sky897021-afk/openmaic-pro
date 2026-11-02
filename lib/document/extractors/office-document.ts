/**
 * Local Office extractor (DOCX / PPTX / XLSX / XLS / DOC / CSV).
 *
 * One provider id covers every format the local parsers can read. They share
 * the same offline, credential-free behavior, so exposing six ids to the
 * registry would only add six derived vendor terms to the provider-neutrality
 * guard without changing any behavior.
 *
 * Modern Office containers use the OOXML parsers; legacy `.doc` and `.xls` use
 * pure-JavaScript OLE/BIFF readers; CSV gets a small RFC-4180 parser.
 */
import { DOCUMENT_MIME_TYPES } from '../mime';
import type { DocumentExtractorInput, DocumentExtractorProvider } from '../types';
import { extractCsvText } from './csv';
import { extractDocText } from './doc';
import { extractDocxText } from './docx';
import { getDocumentExtractorManifestEntry } from './manifest';
import { extractPptxText } from './pptx';
import { extractXlsxText } from './xlsx';

async function extractOfficeDocumentText(input: DocumentExtractorInput): Promise<string> {
  const mime = input.mimeType.toLowerCase();
  if (mime === DOCUMENT_MIME_TYPES.docx) return extractDocxText(input.buffer);
  if (mime === DOCUMENT_MIME_TYPES.pptx) return extractPptxText(input.buffer);
  if (mime === DOCUMENT_MIME_TYPES.xlsx || mime === DOCUMENT_MIME_TYPES.xls) {
    return extractXlsxText(input.buffer);
  }
  if (mime === DOCUMENT_MIME_TYPES.doc) return extractDocText(input.buffer);
  if (mime === DOCUMENT_MIME_TYPES.csv) return extractCsvText(input.buffer);
  throw new Error(`Office document extraction does not support "${input.mimeType}"`);
}

export const officeDocumentExtractorProvider: DocumentExtractorProvider = {
  // Metadata comes from the browser-safe manifest, the single source of truth
  // for extractor identity; the implementation is attached here.
  ...getDocumentExtractorManifestEntry('local-document')!,
  async extract(input) {
    const text = await extractOfficeDocumentText(input);
    return {
      metadata: {
        fileName: input.fileName,
        fileSize: input.fileSize,
        mimeType: input.mimeType,
        providerId: 'local-document',
      },
      blocks: [{ id: 'local_document_1', type: 'text', text }],
      assets: [],
      diagnostics: [],
    };
  },
};
