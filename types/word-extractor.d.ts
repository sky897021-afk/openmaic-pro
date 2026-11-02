/**
 * `word-extractor` ships no type declarations. Only the surface this project
 * uses is declared; add methods here if another caller needs them.
 */
declare module 'word-extractor' {
  interface ExtractedWordDocument {
    getBody(): string;
    getHeaders(options?: { includeFooters?: boolean }): string;
    getFooters(): string;
    getFootnotes(): string;
    getEndnotes(): string;
  }

  export default class WordExtractor {
    extract(input: Buffer | string): Promise<ExtractedWordDocument>;
  }
}
