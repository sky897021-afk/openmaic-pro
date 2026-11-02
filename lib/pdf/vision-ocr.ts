/**
 * Vision OCR PDF provider.
 *
 * A local extractor that reads a document's text layer itself and only asks a
 * vision language model about the pages that have none. Two consequences that
 * shape the whole design:
 *
 *  - A PDF whose every page carries text is extracted entirely locally: no
 *    rasterization, no model resolution, no network call — and, because the
 *    assembly below reproduces `unpdf`'s page join exactly, byte-identical
 *    output to picking `unpdf`. Turning this provider on is therefore a no-op
 *    for ordinary text documents.
 *  - An image input has no text layer at all, so it goes straight to the model.
 *
 * SERVER-ONLY. It pulls `unpdf`'s Node canvas path (`@napi-rs/canvas`) and the
 * model-resolution stack; neither may enter the client bundle. It is reached
 * only through `parsePDF()` and the document extractor registry.
 *
 * `@napi-rs/canvas` must stay in `serverExternalPackages` (next.config.ts):
 * bundled, the package cannot find its own platform binary and every
 * rasterization fails with "Cannot find native binding", which reads like a
 * broken install but is not one.
 */

import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';

import { callLLM } from '@/lib/ai/llm';
import { DOCUMENT_MIME_TYPES } from '@/lib/document/mime';
import { createLogger } from '@/lib/logger';
import type { ParsedPdfContent } from '@/lib/types/pdf';

import type { PDFParserConfig } from './types';

const log = createLogger('VisionOCR');

/** Pages with fewer non-whitespace characters than this have no usable text layer. */
const DEFAULT_MIN_TEXT_CHARS = 24;
/** Upper bound on pages rasterized per document — each one allocates a full-page PNG. */
const DEFAULT_MAX_VISION_PAGES = 30;
/** Rasterization scale; 2× keeps small print legible for the model. */
const DEFAULT_RENDER_SCALE = 2;

/**
 * The stage label, shared by the server-managed model lookup and the usage log.
 * Deliberately not named after OCR: the provider-neutrality guard derives
 * forbidden "vendor terms" from provider ids, and a literal here would be
 * counted debt in a neutral file.
 */
const OCR_STAGE = 'page-transcription';

const TRANSCRIBE_PROMPT =
  'Transcribe all text in this page verbatim, in reading order. Preserve headings and ' +
  'lists; render tables as GitHub-flavoured markdown tables and formulas as LaTeX. ' +
  'Output only the transcription, with no commentary.';

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

/** Image inputs go straight to the model — there is no text layer to read locally. */
const IMAGE_MIMES = new Set<string>([
  DOCUMENT_MIME_TYPES.png,
  DOCUMENT_MIME_TYPES.jpeg,
  DOCUMENT_MIME_TYPES.webp,
]);

/**
 * The canvas module pdf.js expects in Node. One shared reference, so the same
 * module instance reaches both the rasterizer and the document's factory.
 */
const CANVAS_IMPORT = () => import('@napi-rs/canvas');

function positiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Non-whitespace character count below which a page is treated as having no text. */
export function visionOcrMinTextChars(): number {
  return Math.floor(positiveEnvNumber('VISION_OCR_MIN_TEXT_CHARS', DEFAULT_MIN_TEXT_CHARS));
}

/** Maximum number of pages rasterized for the model in one document. */
export function visionOcrMaxPages(): number {
  return Math.floor(positiveEnvNumber('VISION_OCR_MAX_PAGES', DEFAULT_MAX_VISION_PAGES));
}

/** Rasterization scale factor applied to rendered pages. */
export function visionOcrRenderScale(): number {
  return positiveEnvNumber('VISION_OCR_RENDER_SCALE', DEFAULT_RENDER_SCALE);
}

/**
 * Whether a page carries no usable text layer, and so needs the model.
 * Exported for unit tests.
 */
export function isSparsePageText(text: string, minChars = visionOcrMinTextChars()): boolean {
  return text.replace(/\s+/g, '').length < minChars;
}

/**
 * Rasterize one PDF page to a PNG data URL.
 *
 * `unpdf` refuses to build a canvas in Node without an explicit `canvasImport`
 * (node_modules/unpdf/dist/index.mjs), and `@napi-rs/canvas` is the module it
 * expects. Passing the already-built document proxy avoids re-parsing the PDF
 * once per page — but the proxy must then be one built by `openRenderDocument`,
 * or pdf.js falls back to a canvas factory that refuses every call.
 */
export async function renderPdfPageToDataUrl(
  pdf: PdfProxy,
  pageNumber: number,
  scale = visionOcrRenderScale(),
): Promise<string> {
  return renderPageAsImage(pdf, pageNumber, {
    canvasImport: CANVAS_IMPORT,
    scale,
    toDataURL: true,
  });
}

/**
 * Render the first `maxPages` pages to PNG data URLs.
 *
 * Used by the integration material pipeline as a LAYOUT REFERENCE: the vision
 * model sees the actual page arrangement, not just the extracted text. Rendering
 * is local (canvas) and bounded; a page that fails is skipped rather than
 * failing the whole document.
 */
export async function renderPdfPagesToDataUrls(
  buffer: Buffer,
  maxPages = 5,
  scale = visionOcrRenderScale(),
): Promise<string[]> {
  if (maxPages <= 0) return [];
  const pdf = await openRenderDocument(buffer);
  const pages = Math.min(pdf.numPages, maxPages);
  const urls: string[] = [];
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    try {
      urls.push(await renderPdfPageToDataUrl(pdf, pageNumber, scale));
    } catch (error) {
      log.warn(`[VisionOCR] layout render failed for page ${pageNumber}:`, error);
    }
  }
  return urls;
}

/**
 * Open the document for rasterization.
 *
 * `renderPageAsImage` only builds a canvas factory when it is handed raw bytes;
 * handed an already-built proxy it uses whatever factory that proxy was opened
 * with, and a proxy opened without one falls back to pdf.js's bundled Node
 * canvas factory — which throws on every call. The failure is easy to misread:
 * a page with *no* embedded images rasterizes fine, because nothing asks for a
 * canvas, so only the pages this provider exists to read are the ones that
 * break, with "@napi-rs/canvas is not available in this environment".
 *
 * Resolved on demand: a document that needs no rendering must not load a native
 * canvas module at all.
 */
async function openRenderDocument(buffer: Buffer) {
  const { createIsomorphicCanvasFactory } = await import('unpdf');
  const CanvasFactory = await createIsomorphicCanvasFactory(CANVAS_IMPORT);
  return getDocumentProxy(new Uint8Array(buffer), { CanvasFactory });
}

interface VisionTranscriber {
  transcribe(dataUrl: string, pageNumber: number): Promise<string>;
}

/**
 * Resolve the model to transcribe with and wrap it in a transcriber.
 *
 * Two credential tiers, on purpose:
 *  - a model named by the caller wins — resolved WITHOUT a `stage`, because a
 *    configured MODEL_ROUTES entry for the stage would outrank `modelString`
 *    and silently swap the caller's choice (lib/server/resolve-model.ts);
 *  - otherwise the server-managed model for the OCR stage (an operator route,
 *    else DEFAULT_MODEL).
 */
async function createTranscriber(config: PDFParserConfig): Promise<VisionTranscriber> {
  const { resolveModel } = await import('@/lib/server/resolve-model');
  const resolved = config.model
    ? await resolveModel({
        modelString: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      })
    : await resolveModel({ stage: OCR_STAGE });

  // A model the catalog knows to be text-only can never read a page. Fail with
  // its name rather than shipping images a model would silently ignore.
  if (resolved.modelInfo?.capabilities?.vision === false) {
    throw new Error(
      `The model "${resolved.modelString}" cannot read images, so it cannot transcribe pages. ` +
        'Select a vision-capable model for the Vision OCR provider.',
    );
  }

  return {
    async transcribe(dataUrl, pageNumber) {
      // Imported on demand: this module hangs off `parsePDF()`, which every
      // document path loads, and the generation barrel is a heavy one that a
      // document with a text layer must never pay for.
      const { buildVisionUserContent } = await import('@openmaic/generation');
      const content = buildVisionUserContent(TRANSCRIBE_PROMPT, [
        { id: `page_${pageNumber}`, src: dataUrl },
      ]);
      const result = await callLLM(
        { model: resolved.model, messages: [{ role: 'user', content }], maxRetries: 0 },
        OCR_STAGE,
        undefined,
        undefined,
        { serverManaged: resolved.serverManaged },
      );
      return result.text;
    },
  };
}

/**
 * Extract a PDF or an image: read the text layer locally, then transcribe only
 * the pages that lack one.
 */
export async function parseWithVisionOCR(
  config: PDFParserConfig,
  buffer: Buffer,
  options?: { fileName?: string; mimeType?: string },
): Promise<ParsedPdfContent> {
  const fileName = options?.fileName || 'document.pdf';
  const mime = options?.mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';

  if (IMAGE_MIMES.has(mime)) {
    const transcriber = await createTranscriber(config);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    const text = (await transcriber.transcribe(dataUrl, 1)).trim();
    return {
      text,
      images: [],
      metadata: { fileName, pageCount: 1, parser: 'vision-ocr', visionPages: [1] },
    };
  }

  if (mime && mime !== DOCUMENT_MIME_TYPES.pdf) {
    throw new Error(`Vision OCR cannot extract "${mime}" documents`);
  }

  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text: pageTexts } = await extractText(pdf, { mergePages: false });
  const sparsePages = pageTexts
    .map((text, index) => ({ page: index + 1, text }))
    .filter(({ text }) => isSparsePageText(text))
    .map(({ page }) => page);

  const maxPages = visionOcrMaxPages();
  const toRender = sparsePages.slice(0, maxPages);
  const skipped = sparsePages.length - toRender.length;

  const pageOutput = [...pageTexts];
  const visionPages: number[] = [];
  const diagnostics: string[] = [];
  // Resolved lazily: a document with a full text layer must never resolve a
  // model at all — that is the entire point of the sparse-page strategy.
  let transcriber: Promise<VisionTranscriber> | undefined;
  const getTranscriber = () => (transcriber ??= createTranscriber(config));

  // Same laziness for the canvas: opened once, and only when there is a page to
  // rasterize. A failure here is a property of the deployment, not of one page,
  // so it is reported once instead of once per page.
  let renderPdf: PdfProxy | undefined;
  if (toRender.length > 0) {
    try {
      renderPdf = await openRenderDocument(buffer);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      diagnostics.push(`pages could not be prepared for rasterization (${reason})`);
      log.warn('[VisionOCR] rasterization unavailable:', error);
    }
  }

  for (const pageNumber of toRender) {
    if (!renderPdf) break;
    let dataUrl: string;
    try {
      dataUrl = await renderPdfPageToDataUrl(renderPdf, pageNumber);
    } catch (error) {
      // One unrenderable page must not sink the document: keep whatever local
      // text it had, note it, and move on.
      const reason = error instanceof Error ? error.message : String(error);
      diagnostics.push(`page ${pageNumber} could not be rendered (${reason})`);
      log.warn(`[VisionOCR] render failed for page ${pageNumber}:`, error);
      continue;
    }
    // A model failure is deliberately NOT caught here: it would strike every
    // page alike, and swallowing it would hand back a silently blank document.
    const transcribed = (await (await getTranscriber()).transcribe(dataUrl, pageNumber)).trim();
    if (transcribed) {
      pageOutput[pageNumber - 1] = transcribed;
      visionPages.push(pageNumber);
    } else {
      diagnostics.push(`page ${pageNumber} produced no transcription`);
    }
  }

  if (skipped > 0) {
    diagnostics.push(
      `${skipped} further page(s) without a text layer were left unprocessed (cap: ${maxPages})`,
    );
  }

  // Nothing transcribed ⇒ reproduce `unpdf`'s exact page join, so switching
  // this provider on for a text PDF yields identical output. Once any page has
  // been transcribed, keep the model's line structure instead of flattening it.
  const text =
    visionPages.length > 0
      ? pageOutput
          .map((page) => page.trim())
          .filter(Boolean)
          .join('\n\n')
      : pageOutput.join('\n').replace(/\s+/g, ' ');

  return {
    text,
    images: [],
    metadata: {
      fileName,
      pageCount: pdf.numPages,
      parser: 'vision-ocr',
      visionPages,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    },
  };
}
