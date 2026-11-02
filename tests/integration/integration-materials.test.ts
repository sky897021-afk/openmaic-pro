/**
 * Module 2 material records and extraction.
 *
 * The store is file-backed with a 24-hour TTL; these tests pin the round-trip,
 * the opaque-id boundary, and the DOCX path (text + images + layout digest).
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { DOCUMENT_MIME_TYPES } from '@/lib/document/mime';
import { extractIntegrationMaterial } from '@/lib/server/integration/material-extract';
import {
  deleteIntegrationMaterial,
  readIntegrationMaterial,
  saveIntegrationMaterial,
} from '@/lib/server/integration/materials';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

async function makeDocxWithImage(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${NS}><w:body>` +
      '<w:p><w:r><w:t>裂解工段操作说明</w:t></w:r></w:p>' +
      '<w:p><w:r><w:drawing><wp:inline>' +
      '<wp:extent cx="952500" cy="476250"/>' +
      '<a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p>' +
      '</w:body></w:document>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId5" Type="image" Target="media/image1.png"/>' +
      '</Relationships>',
  );
  zip.file('word/media/image1.png', Buffer.from('fake-png'));
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

describe('integration material store', () => {
  it('round-trips a record and removes it', async () => {
    const stored = await saveIntegrationMaterial(
      {
        tenantId: 'test-tenant',
        fileName: 'lesson.txt',
        mimeType: 'text/plain',
        kind: 'txt',
        size: 5,
        parser: 'plain-text',
        text: 'hello',
        images: [],
        layout: {},
      },
      { bytes: Buffer.from('hello'), fileName: 'lesson.txt' },
    );

    try {
      expect(stored.id).toMatch(/^mat_/);
      const loaded = await readIntegrationMaterial(stored.id);
      expect(loaded).toMatchObject({
        id: stored.id,
        fileName: 'lesson.txt',
        text: 'hello',
        tenantId: 'test-tenant',
      });
    } finally {
      await deleteIntegrationMaterial(stored.id);
    }

    await expect(readIntegrationMaterial(stored.id)).resolves.toBeNull();
  });

  it('refuses an id that is not minted by the store', async () => {
    await expect(readIntegrationMaterial('../../etc/passwd')).resolves.toBeNull();
    await expect(readIntegrationMaterial('mat_x')).resolves.toBeNull();
  });
});

describe('extractIntegrationMaterial — DOCX', () => {
  it('keeps text, embedded images and a layout digest', async () => {
    const buffer = await makeDocxWithImage();

    const material = await extractIntegrationMaterial({
      buffer,
      fileName: 'lesson.docx',
      mimeType: DOCUMENT_MIME_TYPES.docx,
    });

    expect(material.kind).toBe('docx');
    expect(material.parser).toBe('local-document');
    expect(material.text).toContain('裂解工段操作说明');
    expect(material.images).toHaveLength(1);
    expect(material.images[0]).toMatchObject({
      id: 'docx_img_1',
      width: 100,
      height: 50,
      kind: 'embedded',
    });
    expect(material.layout.blocks).toEqual([
      { type: 'image', order: 0, imageId: 'docx_img_1', width: 100, height: 50 },
    ]);
    expect(material.layout.summary).toContain('1 embedded image');
  });
});
