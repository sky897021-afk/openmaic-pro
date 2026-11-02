/**
 * Local CSV extraction.
 *
 * CSV is simple until quoting enters the picture; these tests cover commas and
 * newlines inside quoted fields, escaped quotes, delimiter detection and BOM.
 */
import { describe, expect, it } from 'vitest';

import { extractCsvText } from '@/lib/document/extractors/csv';
import { officeDocumentExtractorProvider } from '@/lib/document/extractors/office-document';
import { DOCUMENT_MIME_TYPES } from '@/lib/document/mime';

function csv(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

describe('extractCsvText', () => {
  it('renders a comma-separated file as a markdown table', async () => {
    await expect(extractCsvText(csv('姓名,分数\n张三,95\n李四,88\n'))).resolves.toBe(
      ['| 姓名 | 分数 |', '| --- | --- |', '| 张三 | 95 |', '| 李四 | 88 |'].join('\n'),
    );
  });

  it('keeps commas and newlines inside quoted fields', async () => {
    await expect(extractCsvText(csv('a,b\n"x,y","line1\nline2"\n'))).resolves.toBe(
      ['| a | b |', '| --- | --- |', '| x,y | line1 line2 |'].join('\n'),
    );
  });

  it('unescapes doubled quotes', async () => {
    await expect(extractCsvText(csv('a\n"say ""hi"""\n'))).resolves.toBe(
      ['| a |', '| --- |', '| say "hi" |'].join('\n'),
    );
  });

  it('detects a semicolon delimiter', async () => {
    await expect(extractCsvText(csv('a;b\n1;2\n'))).resolves.toBe(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
    );
  });

  it('strips a UTF-8 BOM', async () => {
    await expect(extractCsvText(csv('﻿a,b\n1,2\n'))).resolves.toBe(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
    );
  });

  it('rejects an empty file', async () => {
    await expect(extractCsvText(csv('  \n'))).rejects.toThrow(/empty/);
  });
});

describe('local-document provider — csv', () => {
  it('dispatches .csv by MIME', async () => {
    const buffer = csv('a,b\n1,2\n');
    const artifact = await officeDocumentExtractorProvider.extract({
      buffer,
      fileName: 'table.csv',
      fileSize: buffer.byteLength,
      mimeType: DOCUMENT_MIME_TYPES.csv,
      config: { providerId: 'local-document' },
    });

    expect(artifact.blocks[0]?.text).toContain('| a | b |');
  });
});
