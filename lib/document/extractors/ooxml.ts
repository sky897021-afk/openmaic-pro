/**
 * Shared helpers for the local OOXML extractors (DOCX / PPTX).
 *
 * These are deliberately small: a tag-level scanner and two markdown helpers.
 * The extractors only need paragraphs, text runs and tables — not a DOM.
 */

/**
 * One XML tag. Quoted attributes are matched before bare text so a `>` inside
 * an attribute value (legal XML, if rare in Office output) does not end the tag
 * early.
 */
export const TAG_PATTERN = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;

export function decodeXmlEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code =
          entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
    }
  });
}

/** A `name="value"` attribute from the raw tag text. */
export function xmlAttribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const match = attributes.match(pattern);
  if (!match) return undefined;
  return decodeXmlEntities(match[1] ?? match[2] ?? '');
}

/** `a:t` → `t`, `row` → `row`; XLSX mixes prefixed and default-namespace tags. */
export function localXmlName(name: string): string {
  const colon = name.indexOf(':');
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

export function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/**
 * Render rows as a markdown table. The first row is treated as the header.
 * Rows are padded to the widest row so the table stays well-formed.
 */
export function renderMarkdownTable(rows: string[][]): string {
  const body = rows.filter((row) => row.length > 0);
  if (body.length === 0) return '';
  const width = Math.max(...body.map((row) => row.length));
  const cells = body.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);
  const line = (row: string[]) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`;
  const [header, ...rest] = cells;
  return [
    line(header),
    `| ${Array<string>(width).fill('---').join(' | ')} |`,
    ...rest.map(line),
  ].join('\n');
}
