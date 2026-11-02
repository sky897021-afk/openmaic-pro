/**
 * Extraction for integration materials.
 *
 * Unlike the module 1 `extract` endpoint, this keeps what the single-game
 * generator needs to REFERENCE the source layout:
 *
 *  - text;
 *  - embedded images with page/size;
 *  - rasterized pages (PDF) as a visual layout reference;
 *  - a compact layout digest (page count, image order/size).
 *
 * PDF images come from the existing unpdf provider (which already extracts
 * per-page images and dimensions); DOCX images come from `docx-media.ts`, and
 * PPTX/XLSX media comes from `ooxml-media.ts`. Standalone raster uploads are
 * kept even when OCR is unavailable, so an image-only upload remains usable.
 */
import { DOCUMENT_MIME_TYPES, normalizeDocumentMimeType } from '@/lib/document/mime';
import { extractDocxText } from '@/lib/document/extractors/docx';
import { extractDocxImages } from '@/lib/document/extractors/docx-media';
import { extractOoxmlMediaImages } from '@/lib/document/extractors/ooxml-media';
import { extractPptxText } from '@/lib/document/extractors/pptx';
import { extractXlsxText } from '@/lib/document/extractors/xlsx';
import { parsePDF } from '@/lib/pdf/pdf-providers';
import { renderPdfPagesToDataUrls } from '@/lib/pdf/vision-ocr';

import { extractIntegrationFile } from './extract';
import type { IntegrationMaterialImage, IntegrationMaterialLayout } from './materials';

const MAX_IMAGES = 50;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_LAYOUT_PAGES = 3;
const STANDALONE_IMAGE_MIME_TYPES = new Set([
  DOCUMENT_MIME_TYPES.png,
  DOCUMENT_MIME_TYPES.jpeg,
  DOCUMENT_MIME_TYPES.webp,
]);

export interface ExtractedIntegrationMaterial {
  text: string;
  parser: string;
  kind: string;
  mimeType: string;
  images: IntegrationMaterialImage[];
  layout: IntegrationMaterialLayout;
}

function kindFor(fileName: string, mimeType: string): string {
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
  return extension || mimeType.split('/').pop() || 'file';
}

function dataUrlBytes(src: string): number {
  const comma = src.indexOf(',');
  return comma >= 0 ? Math.ceil((src.length - comma - 1) * 0.75) : 0;
}

/** Keep a pathological deck from filling the material store. */
function limitImages(images: IntegrationMaterialImage[]): IntegrationMaterialImage[] {
  const kept: IntegrationMaterialImage[] = [];
  let total = 0;
  for (const image of images) {
    const bytes = dataUrlBytes(image.src);
    if (kept.length >= MAX_IMAGES || total + bytes > MAX_IMAGE_BYTES) break;
    total += bytes;
    kept.push(image);
  }
  return kept;
}

function layoutPageLimit(): number {
  const raw = Number(process.env.INTEGRATION_LAYOUT_PAGES ?? DEFAULT_LAYOUT_PAGES);
  return Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.floor(raw))) : DEFAULT_LAYOUT_PAGES;
}

async function extractPdf(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<ExtractedIntegrationMaterial> {
  let parsed: Awaited<ReturnType<typeof parsePDF>> | undefined;
  try {
    parsed = await parsePDF({ providerId: 'unpdf', allowEnvFallback: true }, buffer, {
      fileName,
      mimeType,
    });
  } catch {
    parsed = undefined;
  }

  const pdfImages = parsed?.metadata?.pdfImages;
  const embedded: IntegrationMaterialImage[] =
    pdfImages && pdfImages.length > 0
      ? pdfImages.map((image, index) => ({
          id: image.id,
          src: image.src,
          mimeType: 'image/png',
          order: index,
          pageNumber: image.pageNumber,
          ...(image.width ? { width: image.width } : {}),
          ...(image.height ? { height: image.height } : {}),
          kind: 'embedded' as const,
          ...(image.description ? { description: image.description } : {}),
        }))
      : (parsed?.images ?? []).map((src, index) => ({
          id: `img_${index + 1}`,
          src,
          mimeType: 'image/png',
          order: index,
          kind: 'embedded' as const,
        }));

  let text = parsed?.text?.trim() ?? '';
  let parser = parsed?.metadata?.parser ?? 'unpdf';
  if (!text) {
    // A scanned PDF: the candidate loop can reach vision-ocr (and the page
    // rasters below still provide the visual layout).
    const fallback = await extractIntegrationFile({ buffer, fileName, mimeType });
    text = fallback.text;
    parser = fallback.parser || parser;
  }

  const pageLimit = layoutPageLimit();
  const pageRasters =
    pageLimit > 0 ? await renderPdfPagesToDataUrls(buffer, pageLimit, 1.5).catch(() => []) : [];

  const images = limitImages(embedded);
  const layout: IntegrationMaterialLayout = {
    pageCount: parsed?.metadata?.pageCount ?? pageRasters.length,
    ...(pageRasters.length
      ? { pages: pageRasters.map((src, index) => ({ index: index + 1, src })) }
      : {}),
    ...(images.length
      ? {
          blocks: images.map((image) => ({
            type: 'image' as const,
            order: image.order,
            imageId: image.id,
            ...(image.width ? { width: image.width } : {}),
            ...(image.height ? { height: image.height } : {}),
          })),
        }
      : {}),
    summary: `${parsed?.metadata?.pageCount ?? pageRasters.length} page(s), ${images.length} embedded image(s), ${pageRasters.length} layout page raster(s)`,
  };

  return { text, parser, kind: 'pdf', mimeType, images, layout };
}

async function extractDocx(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<ExtractedIntegrationMaterial> {
  const [text, docxImages] = await Promise.all([
    extractDocxText(buffer),
    extractDocxImages(buffer),
  ]);
  const images = limitImages(
    docxImages.map((image) => ({
      id: image.id,
      src: image.src,
      mimeType: image.mimeType,
      order: image.order,
      kind: 'embedded' as const,
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {}),
    })),
  );

  return {
    text,
    parser: 'local-document',
    kind: 'docx',
    mimeType,
    images,
    layout: {
      ...(images.length
        ? {
            blocks: images.map((image) => ({
              type: 'image' as const,
              order: image.order,
              imageId: image.id,
              ...(image.width ? { width: image.width } : {}),
              ...(image.height ? { height: image.height } : {}),
            })),
          }
        : {}),
      summary: `${images.length} embedded image(s) in reading order (DOCX layout is approximate)`,
    },
  };
}

function embeddedLayout(
  images: IntegrationMaterialImage[],
  summary: string,
): IntegrationMaterialLayout {
  return {
    ...(images.length
      ? {
          blocks: images.map((image) => ({
            type: 'image' as const,
            order: image.order,
            imageId: image.id,
            ...(image.width ? { width: image.width } : {}),
            ...(image.height ? { height: image.height } : {}),
          })),
        }
      : {}),
    summary,
  };
}

async function extractImage(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<ExtractedIntegrationMaterial> {
  if (!STANDALONE_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported standalone image type: ${mimeType}`);
  }

  const fallback = await extractIntegrationFile({ buffer, fileName, mimeType });
  const image: IntegrationMaterialImage = {
    id: 'image_1',
    src: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    order: 0,
    pageNumber: 1,
    kind: 'embedded',
    description: `Source image ${fileName}`,
  };
  const images = limitImages([image]);

  return {
    text: fallback.text,
    parser: fallback.parser || 'local-image',
    kind: kindFor(fileName, mimeType),
    mimeType,
    images,
    layout: embeddedLayout(images, '1 source image'),
  };
}

async function extractOoxml(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  kind: 'pptx' | 'xlsx',
): Promise<ExtractedIntegrationMaterial> {
  const [textResult, imagesResult] = await Promise.allSettled([
    kind === 'pptx' ? extractPptxText(buffer) : extractXlsxText(buffer),
    extractOoxmlMediaImages(buffer, {
      prefix: kind === 'pptx' ? 'ppt/media/' : 'xl/media/',
      idPrefix: `${kind}_img`,
      maxImages: MAX_IMAGES,
      maxTotalBytes: MAX_IMAGE_BYTES,
    }),
  ]);

  const text = textResult.status === 'fulfilled' ? textResult.value : '';
  const extractedImages = imagesResult.status === 'fulfilled' ? imagesResult.value : [];
  if (!text.trim() && extractedImages.length === 0) {
    const reason =
      textResult.status === 'rejected'
        ? textResult.reason
        : imagesResult.status === 'rejected'
          ? imagesResult.reason
          : 'the document produced no readable text or images';
    throw reason instanceof Error ? reason : new Error(String(reason));
  }

  const images = limitImages(
    extractedImages.map((image) => ({
      id: image.id,
      src: image.src,
      mimeType: image.mimeType,
      order: image.order,
      kind: 'embedded' as const,
    })),
  );

  return {
    text,
    parser: 'local-document',
    kind,
    mimeType,
    images,
    layout: embeddedLayout(
      images,
      `${images.length} embedded image(s) in package order (${kind.toUpperCase()} layout is approximate)`,
    ),
  };
}

export async function extractIntegrationMaterial(input: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
}): Promise<ExtractedIntegrationMaterial> {
  const fileName = input.fileName || 'material';
  const normalized = normalizeDocumentMimeType({
    mimeType: input.mimeType,
    fileName,
  });
  const mimeType = (normalized || input.mimeType || '').split(';')[0].trim().toLowerCase();
  const kind = kindFor(fileName, mimeType);

  if (mimeType === DOCUMENT_MIME_TYPES.pdf) {
    return extractPdf(input.buffer, fileName, mimeType);
  }
  if (mimeType === DOCUMENT_MIME_TYPES.docx) {
    return extractDocx(input.buffer, fileName, mimeType);
  }
  if (mimeType === DOCUMENT_MIME_TYPES.pptx) {
    return extractOoxml(input.buffer, fileName, mimeType, 'pptx');
  }
  if (mimeType === DOCUMENT_MIME_TYPES.xlsx) {
    return extractOoxml(input.buffer, fileName, mimeType, 'xlsx');
  }
  if (STANDALONE_IMAGE_MIME_TYPES.has(mimeType)) {
    return extractImage(input.buffer, fileName, mimeType);
  }

  // Remaining formats are text-only. Media formats still use the shared
  // transcript/keyframe extraction path.
  const fallback = await extractIntegrationFile({
    buffer: input.buffer,
    fileName,
    mimeType,
  });
  return {
    text: fallback.text,
    parser: fallback.parser,
    kind: fallback.kind || kind,
    mimeType: fallback.mimeType || mimeType,
    images: [],
    layout: {},
  };
}
