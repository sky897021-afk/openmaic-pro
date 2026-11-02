/**
 * Local DOCX image extraction.
 *
 * `extractDocxText` deliberately ignores embedded images; module 2 needs them
 * as generation material, so this reads the same package with an image focus:
 *
 *  - `word/_rels/document.xml.rels` maps relationship ids to `media/*` parts;
 *  - `word/document.xml` names the drawings in reading order (`a:blip` for
 *    DrawingML, `v:imagedata` for legacy VML) and carries the display size in
 *    `wp:extent` (EMU).
 *
 * The result is a data URL per image plus its 0-based order and display size in
 * CSS pixels. EMF/WMF and other vector formats the vision model cannot consume
 * are skipped rather than emitted as broken data URLs.
 */
import JSZip from 'jszip';

import { localXmlName, TAG_PATTERN, xmlAttribute } from './ooxml';

const EMU_PER_PIXEL = 9_525;
const MAX_IMAGES = 50;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};

export interface DocxImage {
  id: string;
  src: string;
  order: number;
  width?: number;
  height?: number;
  mimeType: string;
}

function resolveMediaPart(target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const parts = `word/${target}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part && part !== '.') resolved.push(part);
  }
  return resolved.join('/');
}

function readRelationships(xml: string | undefined): Map<string, string> {
  const relationships = new Map<string, string>();
  if (!xml) return relationships;
  for (const match of xml.matchAll(TAG_PATTERN)) {
    const [, closing, rawName, attributes] = match;
    if (closing || localXmlName(rawName) !== 'relationship') continue;
    const id = xmlAttribute(attributes, 'Id');
    const target = xmlAttribute(attributes, 'Target');
    if (!id || !target) continue;
    if (!target.toLowerCase().includes('media/')) continue;
    relationships.set(id, resolveMediaPart(target));
  }
  return relationships;
}

const DATA_URL_PREFIX = /^data:[^,]*,/;

/** Decode a data URL into its bytes and MIME type (used by tests and callers). */
export function decodeImageDataUrl(src: string): { mimeType: string; bytes: Buffer } {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(src);
  if (!match) throw new Error('Not a base64 data URL');
  return { mimeType: match[1], bytes: Buffer.from(match[2], 'base64') };
}

export async function extractDocxImages(buffer: Buffer): Promise<DocxImage[]> {
  const archive = await JSZip.loadAsync(buffer);
  const documentXml = await archive.file('word/document.xml')?.async('string');
  if (!documentXml) return [];

  const relationshipsXml = await archive.file('word/_rels/document.xml.rels')?.async('string');
  const relationships = readRelationships(relationshipsXml);

  const images: DocxImage[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let lastExtent: { width?: number; height?: number } = {};

  for (const match of documentXml.matchAll(TAG_PATTERN)) {
    const [, closing, rawName, attributes, selfClosing] = match;
    if (closing) continue;
    const name = localXmlName(rawName);

    if (name === 'extent') {
      const cx = Number(xmlAttribute(attributes, 'cx'));
      const cy = Number(xmlAttribute(attributes, 'cy'));
      lastExtent = {
        ...(Number.isFinite(cx) && cx > 0 ? { width: Math.round(cx / EMU_PER_PIXEL) } : {}),
        ...(Number.isFinite(cy) && cy > 0 ? { height: Math.round(cy / EMU_PER_PIXEL) } : {}),
      };
      if (selfClosing) continue;
      continue;
    }

    if (name !== 'blip' && name !== 'imagedata') continue;
    const relId = xmlAttribute(attributes, name === 'blip' ? 'r:embed' : 'r:id');
    if (!relId || seen.has(relId)) continue;
    const partPath = relationships.get(relId);
    if (!partPath) continue;

    const extension = partPath.split('.').pop()?.toLowerCase() ?? '';
    const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
    if (!mimeType) continue;

    const part = archive.file(partPath);
    if (!part) continue;
    const bytes = Buffer.from(await part.async('uint8array'));
    if (totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) break;

    seen.add(relId);
    totalBytes += bytes.byteLength;
    images.push({
      id: `docx_img_${images.length + 1}`,
      src: `data:${mimeType};base64,${bytes.toString('base64')}`,
      order: images.length,
      mimeType,
      ...(lastExtent.width ? { width: lastExtent.width } : {}),
      ...(lastExtent.height ? { height: lastExtent.height } : {}),
    });
    if (images.length >= MAX_IMAGES) break;
  }

  return images;
}

/** Strip a data URL prefix if a caller needs the raw base64 payload. */
export function stripDataUrlPrefix(src: string): string {
  return src.replace(DATA_URL_PREFIX, '');
}
