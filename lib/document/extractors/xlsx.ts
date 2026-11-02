/**
 * Local XLSX / XLS extractor.
 *
 * Uses SheetJS (`xlsx`) so both the modern OOXML workbook and the legacy BIFF
 * `.xls` container are read by one battle-tested parser, with date/number
 * formats applied. Output is one markdown table per sheet (first row as
 * header), which is what the course-generation model consumes well.
 *
 * Not recovered: charts, images, pivot tables, formulas themselves (the cached
 * value is shown), cell styling.
 */
import * as XLSX from 'xlsx';

import { renderMarkdownTable } from './ooxml';

/** Keep one pathological sheet from consuming the whole extraction budget. */
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;
const MAX_CELL_CHARS = 2_000;

export async function extractXlsxText(buffer: Buffer): Promise<string> {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  if (workbook.SheetNames.length === 0) {
    throw new Error('The workbook contains no worksheets.');
  }

  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return `## Sheet: ${name}\n\n(empty)`;

    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    }) as unknown[][];

    const rows = rawRows
      .map((row) =>
        Array.isArray(row) ? row.map((cell) => String(cell ?? '').slice(0, MAX_CELL_CHARS)) : [],
      )
      .filter((row) => row.some((cell) => cell.trim()))
      .slice(0, MAX_ROWS)
      .map((row) => row.slice(0, MAX_COLUMNS));

    const table = renderMarkdownTable(rows) || '(empty)';
    const truncated =
      rawRows.length > MAX_ROWS
        ? `\n\n> Truncated: only the first ${MAX_ROWS} rows were read.`
        : '';
    return `## Sheet: ${name}\n\n${table}${truncated}`;
  });

  return sheets
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
