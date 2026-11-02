/**
 * Local legacy DOC extractor.
 *
 * `.doc` is the pre-OOXML OLE compound container, which `jszip` cannot read
 * and which is genuinely different from `.docx`. `word-extractor` parses that
 * container in pure JavaScript, so a legacy Word upload needs no cloud
 * provider and no external binary.
 *
 * The body text is what teaching content needs; headers/footers are skipped
 * because they tend to be page numbers and document titles rather than lesson
 * content.
 */
import WordExtractor from 'word-extractor';

export async function extractDocText(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const document = await extractor.extract(buffer);
  const body = document.getBody()?.trim() ?? '';
  if (!body) {
    throw new Error('The .doc document contains no readable text.');
  }
  return body;
}
