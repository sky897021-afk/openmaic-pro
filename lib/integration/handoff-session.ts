/**
 * Build the OpenMAIC generation session from a module-2 handoff payload.
 *
 * The landing page is a shell; the actual contract with the generation pipeline
 * is this session object. Keeping it as a pure function makes the image/layout
 * injection testable without a browser.
 */
import { nanoid } from 'nanoid';

import type { PdfImage } from '@/lib/types/generation';

export interface HandoffMaterialImage {
  id: string;
  src: string;
  mimeType: string;
  order: number;
  pageNumber?: number;
  width?: number;
  height?: number;
  kind: 'embedded' | 'page';
  description?: string;
}

export interface HandoffMaterialLayout {
  pageCount?: number;
  pages?: Array<{ index: number; src: string; width?: number; height?: number }>;
  blocks?: Array<{
    type: 'image' | 'paragraph';
    order: number;
    imageId?: string;
    width?: number;
    height?: number;
  }>;
  summary?: string;
}

export interface HandoffMaterialRecord {
  id: string;
  fileName: string;
  text: string;
  images: HandoffMaterialImage[];
  layout: HandoffMaterialLayout;
}

export interface HandoffPayload {
  handoff: {
    id: string;
    prompt: string;
    mode: 'single-game';
    returnUrl?: string;
    completionToken: string;
    expiresAt: string;
  };
  materials: HandoffMaterialRecord[];
}

export interface HandoffPreviewImage {
  id: string;
  src: string;
  label: string;
  kind: 'embedded' | 'page';
  width?: number;
  height?: number;
}

export interface HandoffMaterialPreview {
  id: string;
  fileName: string;
  textExcerpt: string;
  textLength: number;
  textTruncated: boolean;
  embeddedImages: HandoffPreviewImage[];
  hiddenEmbeddedImages: number;
  layoutPages: HandoffPreviewImage[];
  hiddenLayoutPages: number;
}

export interface HandoffGenerationSession {
  sessionId: string;
  /** Marks this session as a platform handoff (skips review + role generation). */
  handoffId: string;
  requirements: { requirement: string; generationMode: 'single-game' };
  pdfText: string;
  pdfImages: PdfImage[];
  imageStorageIds: string[];
  imageMapping: Record<string, string>;
  documentSources: never[];
  pdfFileName: string;
  sceneOutlines: null;
  currentStep: 'generating';
}

/** Hard cap on images handed to one game generation (embedded + layout pages). */
export const MAX_HANDOFF_GENERATION_IMAGES = 30;
export const MAX_HANDOFF_PREVIEW_TEXT_CHARS = 800;
export const MAX_HANDOFF_PREVIEW_IMAGES_PER_KIND = 4;

export function summarizeHandoffMaterials(payload: HandoffPayload) {
  return {
    chars: payload.materials.reduce((sum, material) => sum + material.text.length, 0),
    images: payload.materials.reduce((sum, material) => sum + material.images.length, 0),
    layoutPages: payload.materials.reduce(
      (sum, material) => sum + (material.layout.pages?.length ?? 0),
      0,
    ),
  };
}

/**
 * Select a bounded amount of already-extracted content for the handoff review.
 * The browser has the full payload, but the landing page should not decode every
 * embedded image or render an entire document when the teacher only needs to
 * confirm that extraction succeeded.
 */
export function buildHandoffMaterialPreviews(
  payload: HandoffPayload,
  options: { textLimit?: number; imageLimitPerKind?: number } = {},
): HandoffMaterialPreview[] {
  const textLimit =
    Number.isFinite(options.textLimit) && Number(options.textLimit) >= 0
      ? Math.floor(Number(options.textLimit))
      : MAX_HANDOFF_PREVIEW_TEXT_CHARS;
  const imageLimit =
    Number.isFinite(options.imageLimitPerKind) && Number(options.imageLimitPerKind) >= 0
      ? Math.floor(Number(options.imageLimitPerKind))
      : MAX_HANDOFF_PREVIEW_IMAGES_PER_KIND;

  return payload.materials.map((material) => {
    const normalizedText = material.text.trim();
    const textChars = Array.from(normalizedText);
    const embeddedImages = [...material.images]
      .sort((a, b) => a.order - b.order)
      .slice(0, imageLimit)
      .map((image) => ({
        id: image.id,
        src: image.src,
        kind: 'embedded' as const,
        label:
          image.description ??
          (image.pageNumber ? `第 ${image.pageNumber} 页内嵌图片` : '内嵌图片'),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
      }));
    const allLayoutPages = [...(material.layout.pages ?? [])].sort((a, b) => a.index - b.index);
    const layoutPages = allLayoutPages.slice(0, imageLimit).map((page) => ({
      id: `layout_${page.index}`,
      src: page.src,
      kind: 'page' as const,
      label: `第 ${page.index} 页版式`,
      ...(page.width ? { width: page.width } : {}),
      ...(page.height ? { height: page.height } : {}),
    }));

    return {
      id: material.id,
      fileName: material.fileName,
      textExcerpt: textChars.slice(0, textLimit).join(''),
      textLength: textChars.length,
      textTruncated: textChars.length > textLimit,
      embeddedImages,
      hiddenEmbeddedImages: Math.max(0, material.images.length - embeddedImages.length),
      layoutPages,
      hiddenLayoutPages: Math.max(0, allLayoutPages.length - layoutPages.length),
    };
  });
}

/**
 * Compose the material text and layout digest, then map the images the model
 * can see. Page rasters are appended as layout-reference images with a
 * description, so the vision model understands they are the page, not a figure.
 */
export function buildHandoffGenerationSession(payload: HandoffPayload): HandoffGenerationSession {
  const text = payload.materials
    .map((material) => `### ${material.fileName}\n\n${material.text}`)
    .join('\n\n');
  const layout = payload.materials
    .map((material) =>
      material.layout.summary
        ? `### 版式参考：${material.fileName}\n${material.layout.summary}`
        : '',
    )
    .filter(Boolean)
    .join('\n\n');
  const pdfText = [text, layout].filter(Boolean).join('\n\n');

  const pdfImages: PdfImage[] = [];
  for (const material of payload.materials) {
    for (const image of material.images) {
      if (pdfImages.length >= MAX_HANDOFF_GENERATION_IMAGES) break;
      pdfImages.push({
        id: `${material.id}_${image.id}`,
        src: image.src,
        pageNumber: image.pageNumber ?? 0,
        description: image.description ?? `${material.fileName} 中的图片`,
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
      });
    }
    for (const page of material.layout.pages ?? []) {
      if (pdfImages.length >= MAX_HANDOFF_GENERATION_IMAGES) break;
      pdfImages.push({
        id: `${material.id}_layout_${page.index}`,
        src: page.src,
        pageNumber: page.index,
        description: `版式参考：${material.fileName} 第 ${page.index} 页`,
      });
    }
  }

  return {
    sessionId: nanoid(),
    handoffId: payload.handoff.id,
    requirements: {
      requirement: payload.handoff.prompt,
      generationMode: 'single-game',
    },
    pdfText,
    pdfImages,
    imageStorageIds: [],
    imageMapping: Object.fromEntries(pdfImages.map((image) => [image.id, image.src])),
    documentSources: [],
    pdfFileName: payload.materials.map((material) => material.fileName).join(', '),
    sceneOutlines: null,
    currentStep: 'generating',
  };
}
