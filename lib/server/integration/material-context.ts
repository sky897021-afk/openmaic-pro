import {
  composeMaterialsText,
  MAX_MATERIAL_TEXT_CHARS,
  type IntegrationMaterial,
} from './contract';
import { readIntegrationMaterial, type IntegrationMaterialRecord } from './materials';
import type { ImageMapping, PdfImage } from '@/lib/types/generation';

/**
 * Keep one generation request bounded. The generation package attaches at most
 * ten images to a vision prompt; the rest stay available as text-described
 * candidates and can still be referenced by an outline.
 */
export const MAX_INTEGRATION_GENERATION_IMAGES = 30;

export interface IntegrationMaterialContext {
  records: IntegrationMaterialRecord[];
  text: string;
  images: string[];
  pdfImages: PdfImage[];
  imageMapping: ImageMapping;
  textTruncated: boolean;
}

export type IntegrationMaterialContextResult =
  | { ok: true; value: IntegrationMaterialContext }
  | { ok: false; message: string };

interface ImageCandidate extends PdfImage {
  sourceOrder: number;
  imageOrder: number;
}

/**
 * Convert stored source records into the inputs the classic generator already
 * understands. This deliberately mirrors the module-2 handoff contract:
 * document text + layout digest, then globally unique image ids backed by a
 * source mapping. Images are deduplicated by bytes/URL so the same asset does
 * not consume multiple vision slots.
 */
export function buildIntegrationMaterialContext(
  records: IntegrationMaterialRecord[],
): IntegrationMaterialContext {
  const materials: IntegrationMaterial[] = records.map((record) => {
    const layoutSummary = record.layout.summary?.trim();
    return {
      title: record.fileName,
      kind: record.kind,
      text: [record.text.trim(), layoutSummary ? `Layout reference: ${layoutSummary}` : '']
        .filter(Boolean)
        .join('\n\n'),
    };
  });
  const completeText = composeMaterialsText(materials);

  const candidates: ImageCandidate[] = [];
  records.forEach((record, sourceOrder) => {
    for (const image of [...record.images].sort((left, right) => left.order - right.order)) {
      if (!image.src) continue;
      candidates.push({
        id: '',
        src: image.src,
        pageNumber: image.pageNumber ?? 1,
        ...(image.description ? { description: image.description } : {}),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
        originalId: image.id,
        sourceDocumentId: record.id,
        sourceDocumentName: record.fileName,
        sourceDocumentOrder: sourceOrder,
        // Embedded figures are useful, but page rasters communicate the
        // document's teaching layout and should win a limited vision budget.
        visionPriority: 1_000 - image.order,
        sourceOrder,
        imageOrder: image.order,
      });
    }

    for (const page of [...(record.layout.pages ?? [])].sort(
      (left, right) => left.index - right.index,
    )) {
      if (!page.src) continue;
      candidates.push({
        id: '',
        src: page.src,
        pageNumber: page.index,
        description: `Layout reference for ${record.fileName}, page ${page.index}`,
        ...(page.width ? { width: page.width } : {}),
        ...(page.height ? { height: page.height } : {}),
        sourceDocumentId: record.id,
        sourceDocumentName: record.fileName,
        sourceDocumentOrder: sourceOrder,
        visionPriority: 2_000 - page.index,
        sourceOrder,
        imageOrder: record.images.length + page.index,
      });
    }
  });

  candidates.sort((left, right) => {
    const priority = (right.visionPriority ?? 0) - (left.visionPriority ?? 0);
    if (priority !== 0) return priority;
    if (left.sourceOrder !== right.sourceOrder) return left.sourceOrder - right.sourceOrder;
    if (left.imageOrder !== right.imageOrder) return left.imageOrder - right.imageOrder;
    return left.src.localeCompare(right.src);
  });

  const seenSrc = new Set<string>();
  const pdfImages: PdfImage[] = [];
  for (const candidate of candidates) {
    if (seenSrc.has(candidate.src)) continue;
    seenSrc.add(candidate.src);
    pdfImages.push({
      id: `img_${pdfImages.length + 1}`,
      src: candidate.src,
      pageNumber: candidate.pageNumber,
      ...(candidate.description ? { description: candidate.description } : {}),
      ...(candidate.width ? { width: candidate.width } : {}),
      ...(candidate.height ? { height: candidate.height } : {}),
      ...(candidate.originalId ? { originalId: candidate.originalId } : {}),
      ...(candidate.sourceDocumentId
        ? { sourceDocumentId: candidate.sourceDocumentId }
        : {}),
      ...(candidate.sourceDocumentName
        ? { sourceDocumentName: candidate.sourceDocumentName }
        : {}),
      ...(candidate.sourceDocumentOrder !== undefined
        ? { sourceDocumentOrder: candidate.sourceDocumentOrder }
        : {}),
      ...(candidate.visionPriority !== undefined
        ? { visionPriority: candidate.visionPriority }
        : {}),
    });
    if (pdfImages.length >= MAX_INTEGRATION_GENERATION_IMAGES) break;
  }

  return {
    records,
    text: completeText.slice(0, MAX_MATERIAL_TEXT_CHARS),
    images: pdfImages.map((image) => image.src),
    pdfImages,
    imageMapping: Object.fromEntries(pdfImages.map((image) => [image.id, image.src])),
    textTruncated: completeText.length > MAX_MATERIAL_TEXT_CHARS,
  };
}

/**
 * Resolve opaque material ids into the source context used by both outline and
 * course generation. The tenant check prevents a valid id from one platform
 * account being replayed by another.
 */
export async function readIntegrationMaterialContext(input: {
  tenantId: string;
  materialIds: readonly string[];
}): Promise<IntegrationMaterialContextResult> {
  const records = await Promise.all(
    input.materialIds.map((materialId) => readIntegrationMaterial(materialId)),
  );

  for (const [index, record] of records.entries()) {
    if (!record) {
      return {
        ok: false,
        message: `materialIds[${index}] is unknown, expired, or unreadable`,
      };
    }
    if (record.tenantId !== input.tenantId) {
      return {
        ok: false,
        message: `materialIds[${index}] does not belong to tenantId "${input.tenantId}"`,
      };
    }
  }

  const stored = records as IntegrationMaterialRecord[];
  return { ok: true, value: buildIntegrationMaterialContext(stored) };
}
