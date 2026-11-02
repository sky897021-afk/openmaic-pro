/**
 * Local PPTX extractor.
 *
 * Reads `ppt/slides/slideN.xml` from the OOXML package and keeps the visible
 * text of each slide: paragraphs, line breaks, tabs and tables. No network,
 * no credentials, no media processing.
 *
 * Deliberately NOT recovered: speaker notes, embedded images/audio/video,
 * charts and SmartArt text that does not appear as an `a:t` run, animations.
 */
import JSZip from 'jszip';

import { decodeXmlEntities, localXmlName, renderMarkdownTable, TAG_PATTERN } from './ooxml';

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;

interface SlideTableState {
  rows: string[][];
  row: string[];
  cell?: string[];
}

function extractSlideBody(xml: string): string {
  const blocks: string[] = [];
  const tables: SlideTableState[] = [];
  let paragraph: { text: string } | null = null;
  let captureText = false;
  let cursor = 0;

  const closeParagraph = () => {
    const current = paragraph;
    paragraph = null;
    if (!current) return;
    const text = current.text.trim();
    const table = tables[tables.length - 1];
    if (table?.cell) {
      if (text) table.cell.push(text);
      return;
    }
    if (text) blocks.push(text);
  };

  const closeTable = () => {
    const table = tables.pop();
    if (!table) return;
    if (table.row.length > 0) table.rows.push(table.row);
    const markdown = renderMarkdownTable(table.rows);
    if (!markdown) return;
    const parent = tables[tables.length - 1];
    if (parent?.cell) {
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

    const [, closing, rawName, , selfClosing] = match;
    const name = localXmlName(rawName);
    const isClosing = closing === '/';

    if (!isClosing) {
      switch (name) {
        case 'p':
          paragraph = { text: '' };
          if (selfClosing) closeParagraph();
          break;
        case 't':
          if (!selfClosing) captureText = true;
          break;
        case 'br':
          if (paragraph) paragraph.text += '\n';
          break;
        case 'tab':
          if (paragraph) paragraph.text += '\t';
          break;
        case 'tbl':
          tables.push({ rows: [], row: [] });
          break;
        case 'tr': {
          const table = tables[tables.length - 1];
          if (table) table.row = [];
          break;
        }
        case 'tc': {
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
      case 't':
        captureText = false;
        break;
      case 'p':
        closeParagraph();
        break;
      case 'tc': {
        const table = tables[tables.length - 1];
        if (table?.cell) {
          table.row.push(table.cell.join(' '));
          table.cell = undefined;
        }
        break;
      }
      case 'tr': {
        const table = tables[tables.length - 1];
        if (table) {
          table.rows.push(table.row);
          table.row = [];
        }
        break;
      }
      case 'tbl':
        closeTable();
        break;
      default:
        break;
    }
  }

  closeParagraph();
  while (tables.length > 0) closeTable();
  return blocks
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract the visible text of a `.pptx` deck as markdown-ish text. */
export async function extractPptxText(buffer: Buffer): Promise<string> {
  const archive = await JSZip.loadAsync(buffer);
  const slides = Object.keys(archive.files)
    .map((path) => ({ path, match: SLIDE_PART.exec(path) }))
    .filter((entry): entry is { path: string; match: RegExpExecArray } => Boolean(entry.match))
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));

  if (slides.length === 0) {
    throw new Error('The file is not a readable .pptx presentation (no slides found).');
  }

  const blocks: string[] = [];
  for (const [index, slide] of slides.entries()) {
    const part = archive.file(slide.path);
    if (!part) continue;
    const body = extractSlideBody(await part.async('string'));
    if (body) blocks.push(`## Slide ${index + 1}\n\n${body}`);
  }

  return blocks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
