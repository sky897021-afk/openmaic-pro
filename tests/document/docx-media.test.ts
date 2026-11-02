/**
 * Local DOCX image extraction.
 *
 * Pins relationship resolution, reading order, display size (EMU → px), and
 * the decision to skip vector formats the vision model cannot consume.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { extractDocxImages } from '@/lib/document/extractors/docx-media';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function documentXml(blips: Array<{ relId: string; cx: number; cy: number }>): string {
  const drawings = blips
    .map(
      (blip) =>
        `<w:p><w:r><w:drawing><wp:inline>` +
        `<wp:extent cx="${blip.cx}" cy="${blip.cy}"/>` +
        `<a:graphic><a:graphicData><a:blip r:embed="${blip.relId}"/></a:graphicData></a:graphic>` +
        `</wp:inline></w:drawing></w:r></w:p>`,
    )
    .join('');
  return `<?xml version="1.0"?><w:document ${NS}><w:body>${drawings}</w:body></w:document>`;
}

async function makeDocx(
  blips: Array<{ relId: string; cx: number; cy: number }>,
  media: Record<string, Buffer>,
  relationships: Array<{ id: string; target: string }>,
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', documentXml(blips));
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      relationships
        .map((rel) => `<Relationship Id="${rel.id}" Type="image" Target="${rel.target}"/>`)
        .join('') +
      '</Relationships>',
  );
  for (const [path, bytes] of Object.entries(media)) zip.file(path, bytes);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

describe('extractDocxImages', () => {
  it('resolves images in reading order with their display size', async () => {
    const buffer = await makeDocx(
      [{ relId: 'rId5', cx: 952_500, cy: 476_250 }],
      { 'word/media/image1.png': Buffer.from('fake-png') },
      [{ id: 'rId5', target: 'media/image1.png' }],
    );

    const images = await extractDocxImages(buffer);

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      id: 'docx_img_1',
      order: 0,
      width: 100,
      height: 50,
      mimeType: 'image/png',
    });
    expect(images[0].src).toBe(
      `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`,
    );
  });

  it('keeps document order across several images', async () => {
    const buffer = await makeDocx(
      [
        { relId: 'rId1', cx: 95_250, cy: 95_250 },
        { relId: 'rId2', cx: 190_500, cy: 95_250 },
      ],
      {
        'word/media/a.png': Buffer.from('a'),
        'word/media/b.jpeg': Buffer.from('b'),
      },
      [
        { id: 'rId1', target: 'media/a.png' },
        { id: 'rId2', target: 'media/b.jpeg' },
      ],
    );

    const images = await extractDocxImages(buffer);

    expect(images.map((image) => image.order)).toEqual([0, 1]);
    expect(images.map((image) => image.mimeType)).toEqual(['image/png', 'image/jpeg']);
    expect(images.map((image) => image.width)).toEqual([10, 20]);
  });

  it('skips vector formats the vision model cannot consume', async () => {
    const buffer = await makeDocx(
      [{ relId: 'rId9', cx: 95_250, cy: 95_250 }],
      { 'word/media/logo.emf': Buffer.from('emf') },
      [{ id: 'rId9', target: 'media/logo.emf' }],
    );

    await expect(extractDocxImages(buffer)).resolves.toEqual([]);
  });

  it('returns an empty list when there is no document part', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    const buffer = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    await expect(extractDocxImages(buffer)).resolves.toEqual([]);
  });
});
