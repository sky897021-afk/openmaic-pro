/**
 * Extract raster media stored inside an OOXML package.
 *
 * PPTX and XLSX keep their source images in `ppt/media/` and `xl/media/`
 * respectively. Unlike DOCX, there is no simple reading-order relationship for
 * every use (a workbook image may float independently of a cell), so callers
 * receive the package order and can describe it as an approximate layout.
 */
import JSZip from 'jszip';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export interface OoxmlMediaImage {
  id: string;
  src: string;
  order: number;
  mimeType: string;
}

export async function extractOoxmlMediaImages(
  buffer: Buffer,
  input: { prefix: string; idPrefix: string; maxImages?: number; maxTotalBytes?: number },
): Promise<OoxmlMediaImage[]> {
  const archive = await JSZip.loadAsync(buffer);
  const maxImages = input.maxImages ?? 50;
  const maxTotalBytes = input.maxTotalBytes ?? 20 * 1024 * 1024;
  const paths = Object.keys(archive.files)
    .filter((path) => path.startsWith(input.prefix))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }),
    );

  const images: OoxmlMediaImage[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const file = archive.file(path);
    if (!file || file.dir) continue;

    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
    if (!mimeType) continue;

    const bytes = Buffer.from(await file.async('uint8array'));
    if (bytes.byteLength === 0 || totalBytes + bytes.byteLength > maxTotalBytes) continue;

    totalBytes += bytes.byteLength;
    images.push({
      id: `${input.idPrefix}_${images.length + 1}`,
      src: `data:${mimeType};base64,${bytes.toString('base64')}`,
      order: images.length,
      mimeType,
    });
    if (images.length >= maxImages) break;
  }

  return images;
}
