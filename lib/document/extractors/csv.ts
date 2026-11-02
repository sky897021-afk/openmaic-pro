/**
 * Local CSV extractor.
 *
 * CSV is plain text, but rendering it as a markdown table keeps the model's
 * row/column structure intact instead of handing it a wall of commas. The
 * parser follows RFC 4180 closely enough for course-material spreadsheets:
 * quoted fields, escaped quotes, and newlines inside quotes.
 */
import { renderMarkdownTable } from './ooxml';

const MAX_ROWS = 1_000;
const MAX_COLUMNS = 50;
const MAX_CELL_CHARS = 2_000;

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  return candidates.reduce(
    (best, candidate) => {
      const count = firstLine.split(candidate).length;
      return count > best.count ? { delimiter: candidate, count } : best;
    },
    { delimiter: ',', count: 1 },
  ).delimiter;
}

function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const pushCell = () => {
    row.push(cell.slice(0, MAX_CELL_CHARS));
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    if (row.length > MAX_COLUMNS) row = row.slice(0, MAX_COLUMNS);
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      pushCell();
    } else if (char === '\n') {
      pushRow();
    } else if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      cell += char;
    }
    if (rows.length > MAX_ROWS) break;
  }

  if (cell.length > 0 || row.length > 0) pushRow();
  return rows;
}

export async function extractCsvText(buffer: Buffer): Promise<string> {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  if (!text.trim()) throw new Error('The CSV file is empty.');

  const rows = parseCsv(text, detectDelimiter(text));
  if (rows.length === 0) throw new Error('The CSV file contains no readable rows.');

  const limited = rows.slice(0, MAX_ROWS);
  const truncated =
    rows.length > MAX_ROWS ? `\n\n> Truncated: only the first ${MAX_ROWS} rows were read.` : '';
  return `${renderMarkdownTable(limited)}${truncated}`;
}
