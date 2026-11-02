/**
 * `vision-ocr` extraction strategy.
 *
 * The provider exists to read documents that have no text layer, and the whole
 * reason it is safe to enable is that it *does nothing* for documents that do.
 * These tests pin that contract, plus the edges around it:
 *
 *  - a text PDF performs no rasterization and never resolves a model, and its
 *    assembled text matches `unpdf`'s page join exactly;
 *  - only the pages whose text layer is sparse are rendered and sent;
 *  - an image input goes straight to the model, with no PDF parse at all;
 *  - the rasterization cap leaves a breadcrumb instead of silently dropping
 *    pages; and
 *  - a page that fails to render costs that page only.
 *
 * `unpdf`, the model-resolution stack and the LLM call are all stubbed, so this
 * is about dispatch and assembly — not about raster output or network behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  /** Stated rather than anonymous so the assertions can name what they expect. */
  class StubCanvasFactory {}
  return {
    StubCanvasFactory,
    getDocumentProxy: vi.fn(),
    extractText: vi.fn(),
    renderPageAsImage: vi.fn(),
    createIsomorphicCanvasFactory: vi.fn(),
    callLLM: vi.fn(),
    resolveModel: vi.fn(),
    buildVisionUserContent: vi.fn(),
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('unpdf', () => ({
  getDocumentProxy: mocks.getDocumentProxy,
  extractText: mocks.extractText,
  renderPageAsImage: mocks.renderPageAsImage,
  createIsomorphicCanvasFactory: mocks.createIsomorphicCanvasFactory,
}));

vi.mock('@openmaic/generation', () => ({
  buildVisionUserContent: mocks.buildVisionUserContent,
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));

import {
  isSparsePageText,
  parseWithVisionOCR,
  renderPdfPageToDataUrl,
  visionOcrMaxPages,
  visionOcrMinTextChars,
} from '@/lib/pdf/vision-ocr';
import { DOCUMENT_MIME_TYPES } from '@/lib/document/mime';

const LONG_LINE = 'A page with a real text layer, long enough to clear the sparse threshold.';

/** A stand-in for `PDFDocumentProxy`; only `numPages` is read by the provider. */
function fakePdf(numPages: number) {
  return { numPages };
}

/** Let the mocked `extractText` answer with one string per page. */
function stubPages(pageTexts: string[]) {
  mocks.extractText.mockResolvedValue({ totalPages: pageTexts.length, text: pageTexts });
  mocks.getDocumentProxy.mockImplementation(async () => fakePdf(pageTexts.length));
}

/** Resolve a vision-capable model, optionally server-managed. */
function stubResolvedModel(overrides: Record<string, unknown> = {}) {
  mocks.resolveModel.mockResolvedValue({
    model: { id: 'stub-model' },
    modelInfo: { capabilities: { vision: true } },
    modelString: 'stub-model',
    serverManaged: false,
    ...overrides,
  });
}

function stubTranscription(text: string) {
  mocks.callLLM.mockResolvedValue({ text });
}

/** The data URLs handed to the model, in call order. */
function sentImageSources(): string[] {
  return mocks.callLLM.mock.calls.map(
    (call) => (call[0] as any).messages[0].content.images[0].src as string,
  );
}

/** The page numbers the LLM was asked about, recovered from the image src. */
function transcribedPages(): number[] {
  return sentImageSources().map((src) => Number(src.split(',').pop()!.replace('PAGE', '')));
}

beforeEach(() => {
  mocks.getDocumentProxy.mockReset().mockResolvedValue(fakePdf(1));
  mocks.extractText.mockReset();
  mocks.renderPageAsImage.mockReset().mockImplementation((_pdf: unknown, pageNumber: number) => {
    return Promise.resolve(`data:image/png;base64,PAGE${pageNumber}`);
  });
  mocks.callLLM.mockReset().mockResolvedValue({ text: 'transcribed page' });
  mocks.resolveModel.mockReset();
  mocks.createIsomorphicCanvasFactory
    .mockReset()
    .mockResolvedValue(mocks.StubCanvasFactory as never);
  mocks.buildVisionUserContent.mockReset().mockImplementation((prompt, images) => ({
    prompt,
    images,
  }));
  stubResolvedModel();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isSparsePageText', () => {
  it('treats whitespace-only pages as having no text layer', () => {
    expect(isSparsePageText('   \n\t  ')).toBe(true);
    expect(isSparsePageText('')).toBe(true);
  });

  it('uses non-whitespace length, not raw length', () => {
    // Long in raw characters, but only 9 of them carry content.
    expect(isSparsePageText('a b c d e f g h i', 10)).toBe(true);
    expect(isSparsePageText(LONG_LINE, 10)).toBe(false);
  });

  it('reads its threshold from the environment, falling back when unusable', () => {
    expect(visionOcrMinTextChars()).toBe(24);
    vi.stubEnv('VISION_OCR_MIN_TEXT_CHARS', '7');
    expect(visionOcrMinTextChars()).toBe(7);
    vi.stubEnv('VISION_OCR_MIN_TEXT_CHARS', 'not-a-number');
    expect(visionOcrMinTextChars()).toBe(24);
  });

  it('caps the rasterization budget, ignoring non-positive overrides', () => {
    expect(visionOcrMaxPages()).toBe(30);
    vi.stubEnv('VISION_OCR_MAX_PAGES', '2');
    expect(visionOcrMaxPages()).toBe(2);
    vi.stubEnv('VISION_OCR_MAX_PAGES', '0');
    expect(visionOcrMaxPages()).toBe(30);
  });
});

describe('parseWithVisionOCR — a document with a text layer', () => {
  it('renders nothing and never resolves a model', async () => {
    const pageTexts = [LONG_LINE, `${LONG_LINE} And a second page of prose.`];
    stubPages(pageTexts);

    const result = await parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
      fileName: 'text.pdf',
      mimeType: DOCUMENT_MIME_TYPES.pdf,
    });

    expect(mocks.renderPageAsImage).not.toHaveBeenCalled();
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
    // Not even the canvas module is loaded — the whole native stack stays shut.
    expect(mocks.createIsomorphicCanvasFactory).not.toHaveBeenCalled();
    expect(mocks.getDocumentProxy).toHaveBeenCalledTimes(1);

    // Switching this provider on for a text PDF must be a no-op: the assembly
    // reproduces `unpdf`'s own page join.
    expect(result.text).toBe(pageTexts.join('\n').replace(/\s+/g, ' '));
    expect(result.metadata?.visionPages).toEqual([]);
    expect(result.metadata?.diagnostics).toBeUndefined();
    expect(result.metadata?.pageCount).toBe(pageTexts.length);
    expect(result.metadata?.parser).toBe('vision-ocr');
  });
});

describe('parseWithVisionOCR — a mixed document', () => {
  it('sends only the sparse pages, keeping local text elsewhere', async () => {
    const pageTexts = [LONG_LINE, '  ', `${LONG_LINE} Third page.`];
    stubPages(pageTexts);
    stubTranscription('Transcribed scan.');

    const result = await parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
      mimeType: DOCUMENT_MIME_TYPES.pdf,
    });

    // Exactly one render, for exactly page 2.
    expect(mocks.renderPageAsImage).toHaveBeenCalledTimes(1);
    expect(mocks.renderPageAsImage.mock.calls[0][1]).toBe(2);
    expect(sentImageSources()).toEqual(['data:image/png;base64,PAGE2']);
    expect(transcribedPages()).toEqual([2]);

    // The document is re-opened for rasterization with a real canvas factory:
    // handed a proxy opened without one, pdf.js falls back to a factory that
    // refuses every call as soon as a page carries an embedded image.
    expect(mocks.getDocumentProxy).toHaveBeenCalledTimes(2);
    const renderOptions = mocks.getDocumentProxy.mock.calls[1][1] as {
      CanvasFactory?: unknown;
    };
    expect(renderOptions.CanvasFactory).toBe(mocks.StubCanvasFactory);
    expect(mocks.createIsomorphicCanvasFactory).toHaveBeenCalledTimes(1);
    expect(mocks.getDocumentProxy.mock.calls[0][1]).toBeUndefined();

    // A transcribed page keeps the model's structure; the local pages remain.
    expect(result.text).toContain('Transcribed scan.');
    expect(result.text).toContain(LONG_LINE);
    expect(result.metadata?.visionPages).toEqual([2]);
  });

  it('leaves a page alone when the model returns nothing, and says so', async () => {
    const pageTexts = [LONG_LINE, ' '];
    stubPages(pageTexts);
    stubTranscription('   ');

    const result = await parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
      mimeType: DOCUMENT_MIME_TYPES.pdf,
    });

    expect(result.metadata?.visionPages).toEqual([]);
    expect(result.metadata?.diagnostics).toEqual(['page 2 produced no transcription']);
  });

  it('keeps local text and moves on when a page cannot be rasterized', async () => {
    const pageTexts = [LONG_LINE, ' ', '  '];
    stubPages(pageTexts);
    mocks.renderPageAsImage
      .mockRejectedValueOnce(new Error('canvas exploded'))
      .mockResolvedValueOnce('data:image/png;base64,PAGE3');
    stubTranscription('Transcribed page three.');

    const result = await parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
      mimeType: DOCUMENT_MIME_TYPES.pdf,
    });

    // Page 2's failure did not stop page 3 from being read.
    expect(sentImageSources()).toEqual(['data:image/png;base64,PAGE3']);
    expect(result.text).toContain('Transcribed page three.');
    expect(result.metadata?.diagnostics).toEqual([
      'page 2 could not be rendered (canvas exploded)',
    ]);
  });

  it('reports pages left behind once the rasterization cap is reached', async () => {
    vi.stubEnv('VISION_OCR_MAX_PAGES', '1');
    const pageTexts = [LONG_LINE, ' ', ' ', ' '];
    stubPages(pageTexts);
    stubTranscription('Only the first scan.');

    const result = await parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
      mimeType: DOCUMENT_MIME_TYPES.pdf,
    });

    expect(mocks.renderPageAsImage).toHaveBeenCalledTimes(1);
    expect(result.metadata?.visionPages).toEqual([2]);
    expect(result.metadata?.diagnostics).toEqual([
      '2 further page(s) without a text layer were left unprocessed (cap: 1)',
    ]);
  });

  it('does not swallow a model failure behind a blank document', async () => {
    const pageTexts = [LONG_LINE, ' '];
    stubPages(pageTexts);
    mocks.callLLM.mockRejectedValue(new Error('model unavailable'));

    await expect(
      parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
        mimeType: DOCUMENT_MIME_TYPES.pdf,
      }),
    ).rejects.toThrow('model unavailable');
  });

  it('reports an unusable canvas once for the document, not once per page', async () => {
    const pageTexts = [LONG_LINE, ' ', ' '];
    stubPages(pageTexts);
    mocks.createIsomorphicCanvasFactory.mockRejectedValue(
      new Error('@napi-rs/canvas is unavailable'),
    );

    const result = await parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
      mimeType: DOCUMENT_MIME_TYPES.pdf,
    });

    expect(mocks.renderPageAsImage).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
    // The pages still carry their local text; only the rasterization is lost.
    expect(result.metadata?.visionPages).toEqual([]);
    expect(result.metadata?.diagnostics).toEqual([
      'pages could not be prepared for rasterization (@napi-rs/canvas is unavailable)',
    ]);
    expect(result.text).toContain(LONG_LINE);
  });
});

describe('parseWithVisionOCR — an image input', () => {
  it('goes straight to the model with no PDF parse', async () => {
    stubTranscription('Text read from the image.');
    const buffer = Buffer.from('fake-png-bytes');

    const result = await parseWithVisionOCR({ providerId: 'vision-ocr' }, buffer, {
      fileName: 'scan.png',
      mimeType: DOCUMENT_MIME_TYPES.png,
    });

    expect(mocks.getDocumentProxy).not.toHaveBeenCalled();
    expect(mocks.renderPageAsImage).not.toHaveBeenCalled();
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(sentImageSources()).toEqual([
      `data:${DOCUMENT_MIME_TYPES.png};base64,${buffer.toString('base64')}`,
    ]);
    expect(result.text).toBe('Text read from the image.');
    expect(result.metadata?.pageCount).toBe(1);
    expect(result.metadata?.visionPages).toEqual([1]);
  });

  it('rejects a MIME type it has no strategy for', async () => {
    await expect(
      parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('x'), {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).rejects.toThrow(/cannot extract/);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });
});

describe('createTranscriber credential tiers', () => {
  it('resolves a caller-named model without a stage', async () => {
    stubPages([' ']);
    stubResolvedModel({ modelString: 'openai:gpt-vision' });
    stubTranscription('ok');

    await parseWithVisionOCR(
      {
        providerId: 'vision-ocr',
        model: 'openai:gpt-vision',
        apiKey: 'k',
        baseUrl: 'https://x/v1',
      },
      Buffer.from('pdf'),
      { mimeType: DOCUMENT_MIME_TYPES.pdf },
    );

    // A configured MODEL_ROUTES entry for a stage outranks `modelString`, so
    // passing one here would silently swap the caller's model.
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      modelString: 'openai:gpt-vision',
      apiKey: 'k',
      baseUrl: 'https://x/v1',
    });
    expect(mocks.resolveModel.mock.calls[0][0]).not.toHaveProperty('stage');
  });

  it('falls back to the managed stage route when the caller names no model', async () => {
    stubPages([' ']);
    stubResolvedModel({ serverManaged: true });
    stubTranscription('ok');

    await parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
      mimeType: DOCUMENT_MIME_TYPES.pdf,
    });

    expect(mocks.resolveModel).toHaveBeenCalledWith({ stage: 'page-transcription' });
    // A server-managed model must still arm `callLLM`'s fallback.
    expect(mocks.callLLM.mock.calls[0][4]).toEqual({ serverManaged: true });
  });

  it('names the model when it is known to be unable to read images', async () => {
    stubPages([' ']);
    stubResolvedModel({
      modelString: 'text-only-model',
      modelInfo: { capabilities: { vision: false } },
    });

    await expect(
      parseWithVisionOCR({ providerId: 'vision-ocr' }, Buffer.from('pdf'), {
        mimeType: DOCUMENT_MIME_TYPES.pdf,
      }),
    ).rejects.toThrow(/text-only-model/);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});

describe('renderPdfPageToDataUrl', () => {
  it('supplies the Node canvas module unpdf demands', async () => {
    mocks.renderPageAsImage.mockResolvedValue('data:image/png;base64,X');
    const pdf = fakePdf(3) as never;

    await renderPdfPageToDataUrl(pdf, 3, 4);

    expect(mocks.renderPageAsImage).toHaveBeenCalledTimes(1);
    const [passedPdf, pageNumber, options] = mocks.renderPageAsImage.mock.calls[0] as [
      unknown,
      number,
      { canvasImport: () => unknown; scale: number; toDataURL: boolean },
    ];
    // The same proxy is reused, so the PDF is not re-parsed per page.
    expect(passedPdf).toBe(pdf);
    expect(pageNumber).toBe(3);
    expect(options.scale).toBe(4);
    expect(options.toDataURL).toBe(true);
    expect(typeof options.canvasImport).toBe('function');
  });
});
