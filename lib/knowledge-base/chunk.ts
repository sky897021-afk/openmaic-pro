/**
 * Text chunking for the owner knowledge base.
 *
 * A chunk is the retrieval unit: it is what gets embedded, stored, and handed
 * back to the model. Two properties decide whether retrieval is any good, and
 * both are the whole reason this is not a two-line `slice` loop:
 *
 *  - **Chunks follow the document's own structure.** These sources are
 *    operating manuals: a page of prose, then a table, then a numbered step
 *    list. Cutting every N characters regardless of newlines slices rows in
 *    half and merges the tail of one procedure onto the head of the next, so
 *    the embedded vector describes no single thing. Lines are accumulated
 *    whole wherever they fit, and only a line that alone exceeds the budget is
 *    split.
 *  - **Neighbouring chunks overlap.** A fact that straddles a boundary — a
 *    reading whose unit is on the previous line, a procedure whose condition
 *    is in the preceding sentence — is unreachable from either side if the
 *    halves are disjoint. The tail of each chunk is repeated at the head of
 *    the next, so any span shorter than the overlap is wholly inside at least
 *    one chunk.
 *
 * Character offsets are UTF-16 units, matching every other text measurement in
 * this codebase, and every boundary snaps back off a surrogate pair so a chunk
 * never ends mid-character.
 */

/** Target chunk size. Roughly 300–450 Chinese characters, plus ASCII. */
export const CHUNK_TARGET_CHARS = 900;
/**
 * How much of a chunk's tail is repeated at the head of the next.
 *
 * Must stay well under {@link CHUNK_TARGET_CHARS}: the overlap is duplicated
 * text, so every unit of it is paid for twice — once in storage, and again in
 * every prompt that retrieves the chunk.
 */
export const CHUNK_OVERLAP_CHARS = 150;
/** A chunk below this is folded into its neighbour rather than stored alone. */
export const CHUNK_MIN_CHARS = 24;

export interface TextChunk {
  /** The chunk's text, verbatim from the source plus the overlap prefix. */
  text: string;
  /** Offset in the source of the chunk's first own (non-overlap) character. */
  start: number;
  /** Offset in the source just past its last own character. */
  end: number;
}

const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

/**
 * Snap an index back off a surrogate pair.
 *
 * `slice` counts UTF-16 units, so a boundary can land between the halves of one
 * emoji and hand each neighbour a broken character — which then embeds as the
 * replacement glyph rather than as itself.
 */
export function codePointBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const here = text.charCodeAt(index);
  const previous = text.charCodeAt(index - 1);
  const splitsPair =
    here >= LOW_SURROGATE_START &&
    here <= LOW_SURROGATE_END &&
    previous >= HIGH_SURROGATE_START &&
    previous <= HIGH_SURROGATE_END;
  return splitsPair ? index - 1 : index;
}

/** One line with the source span it occupies, newline included. */
interface SourceLine {
  start: number;
  end: number;
}

/** Split into lines by span, so offsets stay exact and no content is rebuilt. */
function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue;
    lines.push({ start, end: index + 1 });
    start = index + 1;
  }
  if (start < text.length) lines.push({ start, end: text.length });
  return lines;
}

/**
 * Split one over-long line into budget-sized spans.
 *
 * The manual's instrument tables are a single line hundreds of thousands of
 * characters long, so this path is not hypothetical: without it, the whole
 * table would become one chunk and none of it would be retrievable.
 */
function splitWideLine(text: string, line: SourceLine, maxChars: number): SourceLine[] {
  const spans: SourceLine[] = [];
  let cursor = line.start;
  while (cursor < line.end) {
    const limit = codePointBoundary(text, Math.min(cursor + maxChars, line.end));
    // A boundary snapped back onto `cursor` would spin forever; the only way it
    // can is a single code point wider than the budget, which cannot exist.
    const end = limit > cursor ? limit : cursor + 1;
    spans.push({ start: cursor, end });
    cursor = end;
  }
  return spans;
}

/**
 * Chunk one document's extracted text.
 *
 * Returns `[]` for text with nothing in it: an empty document is not an error
 * at this layer, it is simply nothing to index, and the caller distinguishes
 * the two by the count rather than by an exception.
 */
export function chunkText(
  text: string,
  options: { targetChars?: number; overlapChars?: number } = {},
): TextChunk[] {
  const target = Math.max(1, options.targetChars ?? CHUNK_TARGET_CHARS);
  const overlap = Math.max(0, Math.min(options.overlapChars ?? CHUNK_OVERLAP_CHARS, target - 1));
  if (!text.trim()) return [];

  const spans: SourceLine[] = [];
  for (const line of sourceLines(text)) {
    if (line.end - line.start <= target) {
      spans.push(line);
      continue;
    }
    // Over-long line: keep any leading short portion with the advancing packer
    // by splitting the whole line into budget-sized spans.
    spans.push(...splitWideLine(text, line, target));
  }

  const chunks: TextChunk[] = [];
  let packStart: number | null = null;
  let packEnd = 0;
  const flush = () => {
    if (packStart === null) return;
    const start = codePointBoundary(text, packStart);
    const end = codePointBoundary(text, packEnd);
    if (end > start) chunks.push({ text: '', start, end });
    packStart = null;
  };

  for (const span of spans) {
    if (packStart !== null && span.end - packStart > target) flush();
    packStart ??= span.start;
    packEnd = span.end;
  }
  flush();

  // Materialize with the overlap prefix. The prefix is the previous chunk's own
  // tail, taken from the source rather than from the previous chunk's string so
  // the two can never disagree about what the document says.
  return chunks.map((chunk, index) => {
    if (index === 0) return { ...chunk, text: text.slice(chunk.start, chunk.end) };
    const previous = chunks[index - 1]!;
    const prefixStart = codePointBoundary(
      text,
      Math.max(previous.start, previous.end - overlap),
    );
    const merged = { start: prefixStart, end: chunk.end };
    return { ...merged, text: text.slice(merged.start, merged.end) };
  });
}

/** The chunks actually worth embedding: drops whitespace-only and stub spans. */
export function indexableChunks(
  text: string,
  options: { targetChars?: number; overlapChars?: number; minChars?: number } = {},
): TextChunk[] {
  const minChars = options.minChars ?? CHUNK_MIN_CHARS;
  return chunkText(text, options).filter((chunk) => chunk.text.trim().length >= minChars);
}