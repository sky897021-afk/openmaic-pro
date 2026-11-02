/**
 * Local XLSX / XLS extraction (SheetJS).
 *
 * Pins the shared behavior for both containers: sheet names/order, formatted
 * values, sparse columns, booleans, the row cap, and the local-document
 * dispatch for both MIME types.
 */
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import { officeDocumentExtractorProvider } from '@/lib/document/extractors/office-document';
import { extractXlsxText } from '@/lib/document/extractors/xlsx';
import { DOCUMENT_MIME_TYPES } from '@/lib/document/mime';

interface SheetFixture {
  name: string;
  rows: unknown[][];
}

function makeWorkbook(
  sheets: readonly SheetFixture[],
  bookType: 'xlsx' | 'biff8' = 'xlsx',
): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  return XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer;
}

describe('extractXlsxText', () => {
  it('renders each sheet as a markdown table', async () => {
    const buffer = makeWorkbook([
      {
        name: '成绩',
        rows: [
          ['姓名', '分数'],
          ['张三', 95],
          ['李四', 88],
        ],
      },
    ]);

    await expect(extractXlsxText(buffer)).resolves.toBe(
      [
        '## Sheet: 成绩',
        '',
        '| 姓名 | 分数 |',
        '| --- | --- |',
        '| 张三 | 95 |',
        '| 李四 | 88 |',
      ].join('\n'),
    );
  });

  it('reads a legacy .xls (BIFF8) workbook with the same parser', async () => {
    const buffer = makeWorkbook(
      [
        {
          name: 'Legacy',
          rows: [
            ['位号', '说明'],
            ['E-101', '裂解炉'],
          ],
        },
      ],
      'biff8',
    );

    await expect(extractXlsxText(buffer)).resolves.toBe(
      ['## Sheet: Legacy', '', '| 位号 | 说明 |', '| --- | --- |', '| E-101 | 裂解炉 |'].join('\n'),
    );
  });

  it('keeps sparse columns aligned and renders booleans', async () => {
    const buffer = makeWorkbook([
      {
        name: 'S',
        rows: [
          ['A', null, 'C'],
          [1, true, false],
        ],
      },
    ]);

    const text = await extractXlsxText(buffer);

    expect(text).toContain('| A |  | C |');
    expect(text).toContain('| 1 | TRUE | FALSE |');
  });

  it('caps the number of rows and says so', async () => {
    const rows = Array.from({ length: 501 }, (_unused, index) => [index + 1]);
    const buffer = makeWorkbook([{ name: 'S', rows }]);

    const text = await extractXlsxText(buffer);

    expect(text).toContain('Truncated: only the first 500 rows');
    expect(text).not.toContain('| 501 |');
  });
});

describe('local-document provider — xlsx / xls', () => {
  it.each([
    ['xlsx', DOCUMENT_MIME_TYPES.xlsx],
    ['xls', DOCUMENT_MIME_TYPES.xls],
  ] as const)('dispatches %s by MIME', async (label, mimeType) => {
    const buffer = makeWorkbook(
      [{ name: 'S', rows: [['A'], [label]] }],
      label === 'xls' ? 'biff8' : 'xlsx',
    );
    const artifact = await officeDocumentExtractorProvider.extract({
      buffer,
      fileName: `sheet.${label}`,
      fileSize: buffer.byteLength,
      mimeType,
      config: { providerId: 'local-document' },
    });

    expect(artifact.blocks[0]?.text).toContain(`| ${label} |`);
  });
});
