/**
 * Local DOCX extraction.
 *
 * The point of this extractor is that a Word upload works with no credentials
 * and no network: it reads the OOXML package it was handed. These tests pin the
 * parts of WordprocessingML that carry teaching content — paragraphs, headings,
 * lists, tables and character entities — plus the failure mode for a file that
 * is not actually a `.docx`.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { extractDocxText } from '@/lib/document/extractors/docx';
import { officeDocumentExtractorProvider } from '@/lib/document/extractors/office-document';
import { DOCUMENT_MIME_TYPES } from '@/lib/document/mime';

const DOCX_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function documentXml(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<w:document xmlns:w="${DOCX_NS}"><w:body>${body}</w:body></w:document>`
  );
}

async function makeDocx(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', documentXml(body));
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

function paragraph(text: string, properties = ''): string {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

describe('extractDocxText', () => {
  it('reads paragraphs in order and decodes entities and inline breaks', async () => {
    const buffer = await makeDocx(
      '<w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Line</w:t><w:tab/><w:t>two</w:t><w:br/><w:t>three</w:t></w:r></w:p>',
    );

    await expect(extractDocxText(buffer)).resolves.toBe('A & B\nLine\ttwo\nthree');
  });

  it('recognises headings from both pStyle and outlineLvl', async () => {
    // `w:pStyle` is the common case; `w:outlineLvl` is what localized Word
    // writes when the style id is a bare number, so both are honoured.
    const buffer = await makeDocx(
      paragraph('Overview', '<w:pStyle w:val="Heading1"/>') +
        paragraph('Details', '<w:outlineLvl w:val="1"/>'),
    );

    await expect(extractDocxText(buffer)).resolves.toBe('# Overview\n## Details');
  });

  it('renders numbered and bulleted paragraphs as list items', async () => {
    const buffer = await makeDocx(paragraph('第一步', '<w:numPr/>'));

    await expect(extractDocxText(buffer)).resolves.toBe('- 第一步');
  });

  it('renders a table as markdown and joins multi-paragraph cells', async () => {
    const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
    const buffer = await makeDocx(
      '<w:tbl>' +
        `<w:tr>${cell('位号')}${cell('说明')}</w:tr>` +
        `<w:tr>${cell('E-101')}<w:tc><w:p><w:r><w:t>裂解</w:t></w:r></w:p><w:p><w:r><w:t>炉</w:t></w:r></w:p></w:tc></w:tr>` +
        '</w:tbl>',
    );

    await expect(extractDocxText(buffer)).resolves.toBe(
      '| 位号 | 说明 |\n| --- | --- |\n| E-101 | 裂解 炉 |',
    );
  });

  it('escapes a pipe inside a cell so the row stays well-formed', async () => {
    const buffer = await makeDocx(
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A | B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    );

    await expect(extractDocxText(buffer)).resolves.toBe('| A \\| B |\n| --- |');
  });

  it('rejects a package without word/document.xml', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    const buffer = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));

    await expect(extractDocxText(buffer)).rejects.toThrow(/word\/document\.xml/);
  });

  it('rejects bytes that are not a zip archive at all', async () => {
    await expect(extractDocxText(Buffer.from('not a docx'))).rejects.toThrow();
  });
});

describe('local-document provider', () => {
  it('returns the extracted text as one text block under its own id', async () => {
    const buffer = await makeDocx(paragraph('第一章 概述') + paragraph('裂解炉是核心设备'));

    const artifact = await officeDocumentExtractorProvider.extract({
      buffer,
      fileName: 'lesson.docx',
      fileSize: buffer.byteLength,
      mimeType: DOCUMENT_MIME_TYPES.docx,
      config: { providerId: 'local-document' },
    });

    expect(artifact.metadata).toMatchObject({
      fileName: 'lesson.docx',
      mimeType: DOCUMENT_MIME_TYPES.docx,
      providerId: 'local-document',
    });
    expect(artifact.blocks).toHaveLength(1);
    expect(artifact.blocks[0]).toMatchObject({
      type: 'text',
      text: '第一章 概述\n裂解炉是核心设备',
    });
    expect(artifact.assets).toEqual([]);
    expect(artifact.diagnostics).toEqual([]);
  });
});
