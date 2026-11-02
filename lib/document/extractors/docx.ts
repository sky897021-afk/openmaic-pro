/**
 * Local DOCX extractor.
 *
 * Reads the OOXML package with `jszip` and walks `word/document.xml` directly:
 * no network call, no credentials, no native dependency. A `.docx` carries its
 * own text, so auto-selection must prefer this over the cloud extractors —
 * otherwise a Word upload resolves to an unconfigured MinerU/AliDocMind
 * deployment and fails with a configuration error the teacher cannot act on.
 *
 * The walk is a tag-level state machine rather than a DOM build: a document
 * part can be several megabytes, and the only structure this extractor needs is
 * paragraphs, headings, lists and tables. It is not a general OOXML parser.
 *
 * Deliberately NOT recovered (the manifest advertises exactly this): embedded
 * images, equations (OMML), headers/footers and footnotes. Text inside tracked
 * insertions is kept; tracked deletions (`w:delText`) and field codes
 * (`w:instrText`) are not, because neither is part of the visible document.
 *
 * Legacy OLE `.doc` is a different container and stays on the cloud providers.
 */
import JSZip from 'jszip';

import { decodeXmlEntities, renderMarkdownTable, TAG_PATTERN, xmlAttribute } from './ooxml';

/** The OPC part that holds the body text. */
const MAIN_DOCUMENT_PART = 'word/document.xml';

interface ParagraphState {
  text: string;
  /** `w:pStyle/@w:val` — only the built-in heading styles are recognised. */
  style?: string;
  /** `w:outlineLvl/@w:val` + 1. The reliable heading signal across locales. */
  outlineLevel?: number;
  isList: boolean;
}

interface TableState {
  rows: string[][];
  row: string[];
  /** Paragraph text of the cell being read; `undefined` outside a cell. */
  cell?: string[];
}

function headingLevelFromStyle(style: string | undefined): number {
  if (!style) return 0;
  const match = /^heading\s*([1-6])$/i.exec(style.trim());
  return match ? Number(match[1]) : 0;
}

function emitParagraph(blocks: string[], paragraph: ParagraphState, text: string): void {
  if (!text) {
    // Keep intentional blank lines; the final join collapses runs of them.
    blocks.push('');
    return;
  }
  // `w:outlineLvl` is what Word writes for built-in headings in every locale,
  // including locales whose `w:pStyle/@w:val` is a bare number.
  const level = paragraph.outlineLevel || headingLevelFromStyle(paragraph.style);
  if (level > 0) {
    blocks.push(`${'#'.repeat(Math.min(level, 6))} ${text}`);
    return;
  }
  blocks.push(paragraph.isList ? `- ${text}` : text);
}

/** Extract the visible body text of a `.docx` package as markdown-ish text. */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const archive = await JSZip.loadAsync(buffer);
  const part = archive.file(MAIN_DOCUMENT_PART);
  if (!part) {
    throw new Error(
      'The file is not a readable .docx document (missing word/document.xml). ' +
        'Legacy .doc files must be converted to .docx first.',
    );
  }
  const xml = await part.async('string');

  const blocks: string[] = [];
  const tables: TableState[] = [];
  let paragraph: ParagraphState | null = null;
  let captureText = false;
  let cursor = 0;

  const closeParagraph = () => {
    const current = paragraph;
    paragraph = null;
    if (!current) return;
    const text = current.text.trim();
    const table = tables[tables.length - 1];
    if (table?.cell) {
      // Inside a table cell, structure is flattened: a cell is one line.
      if (text) table.cell.push(text);
      return;
    }
    emitParagraph(blocks, current, text);
  };

  const closeTable = () => {
    const table = tables.pop();
    if (!table) return;
    if (table.row.length > 0) table.rows.push(table.row);
    const markdown = renderMarkdownTable(table.rows);
    if (!markdown) return;
    const parent = tables[tables.length - 1];
    if (parent?.cell) {
      // Nested tables are flattened into the enclosing cell so the outer table
      // stays well-formed.
      parent.cell.push(markdown.replace(/\n/g, ' / '));
    } else {
      blocks.push(markdown);
    }
  };

  for (const match of xml.matchAll(TAG_PATTERN)) {
    const index = match.index ?? 0;
    if (captureText) {
      const between = xml.slice(cursor, index);
      if (between && paragraph) paragraph.text += decodeXmlEntities(between);
    }
    cursor = index + match[0].length;

    const [, closing, rawName, attributes, selfClosing] = match;
    const name = rawName.toLowerCase();
    const isClosing = closing === '/';

    if (!isClosing) {
      switch (name) {
        case 'w:p':
          paragraph = { text: '', isList: false };
          if (selfClosing) closeParagraph();
          break;
        case 'w:pstyle':
          if (paragraph) paragraph.style = xmlAttribute(attributes, 'w:val');
          break;
        case 'w:outlinelvl': {
          if (!paragraph) break;
          const value = Number(xmlAttribute(attributes, 'w:val'));
          if (Number.isInteger(value) && value >= 0 && value <= 8) {
            paragraph.outlineLevel = value + 1;
          }
          break;
        }
        case 'w:numpr':
          if (paragraph) paragraph.isList = true;
          break;
        case 'w:t':
          // Self-closing means an empty run; nothing to capture.
          if (!selfClosing) captureText = true;
          break;
        case 'w:tab':
          if (paragraph) paragraph.text += '\t';
          break;
        case 'w:br':
        case 'w:cr':
          if (paragraph) paragraph.text += '\n';
          break;
        case 'w:tbl':
          tables.push({ rows: [], row: [] });
          break;
        case 'w:tr': {
          const table = tables[tables.length - 1];
          if (table) table.row = [];
          break;
        }
        case 'w:tc': {
          const table = tables[tables.length - 1];
          if (table) table.cell = [];
          break;
        }
        default:
          break;
      }
      continue;
    }

    switch (name) {
      case 'w:t':
        captureText = false;
        break;
      case 'w:p':
        closeParagraph();
        break;
      case 'w:tc': {
        const table = tables[tables.length - 1];
        if (table?.cell) {
          table.row.push(table.cell.join(' '));
          table.cell = undefined;
        }
        break;
      }
      case 'w:tr': {
        const table = tables[tables.length - 1];
        if (table) {
          table.rows.push(table.row);
          table.row = [];
        }
        break;
      }
      case 'w:tbl':
        closeTable();
        break;
      default:
        break;
    }
  }

  // Tolerate a truncated part rather than losing everything already read.
  closeParagraph();
  while (tables.length > 0) closeTable();

  return blocks
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
