/**
 * Local PPTX extraction.
 *
 * Pins slide order, paragraph/line-break text, tables as markdown, and a clear
 * failure for a package without slides.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { officeDocumentExtractorProvider } from '@/lib/document/extractors/office-document';
import { extractPptxText } from '@/lib/document/extractors/pptx';
import { DOCUMENT_MIME_TYPES } from '@/lib/document/mime';

function slideXml(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    `<p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
  );
}

function textBox(...paragraphs: string[]): string {
  return (
    '<p:sp><p:txBody>' +
    paragraphs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('') +
    '</p:txBody></p:sp>'
  );
}

function table(rows: string[][]): string {
  const cell = (text: string) =>
    `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
  return (
    '<p:graphicFrame><a:graphic><a:graphicData><a:tbl>' +
    rows.map((row) => `<a:tr>${row.map(cell).join('')}</a:tr>`).join('') +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

async function makePptx(slides: readonly string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  slides.forEach((body, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, slideXml(body));
  });
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

describe('extractPptxText', () => {
  it('reads slides in numeric order with paragraphs and tables', async () => {
    const buffer = await makePptx([
      textBox('第一页标题', '第一页正文') +
        table([
          ['位号', '说明'],
          ['E-101', '裂解炉'],
        ]),
      textBox('第二页标题'),
    ]);

    await expect(extractPptxText(buffer)).resolves.toBe(
      [
        '## Slide 1',
        '',
        '第一页标题',
        '第一页正文',
        '| 位号 | 说明 |',
        '| --- | --- |',
        '| E-101 | 裂解炉 |',
        '',
        '## Slide 2',
        '',
        '第二页标题',
      ].join('\n'),
    );
  });

  it('sorts slides by their part number, not zip insertion order', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('ppt/slides/slide2.xml', slideXml(textBox('second')));
    zip.file('ppt/slides/slide1.xml', slideXml(textBox('first')));

    const text = await extractPptxText(
      Buffer.from(await zip.generateAsync({ type: 'uint8array' })),
    );

    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
  });

  it('keeps line breaks and tabs inside a paragraph', async () => {
    const buffer = await makePptx([
      '<p:sp><p:txBody><a:p><a:r><a:t>Line</a:t><a:br/><a:t>two</a:t><a:tab/><a:t>three</a:t></a:r></a:p></p:txBody></p:sp>',
    ]);

    await expect(extractPptxText(buffer)).resolves.toBe('## Slide 1\n\nLine\ntwo\tthree');
  });

  it('skips an empty slide rather than emitting a bare heading', async () => {
    const buffer = await makePptx(['', textBox('只有这页有字')]);

    await expect(extractPptxText(buffer)).resolves.toBe('## Slide 2\n\n只有这页有字');
  });

  it('rejects a package without slide parts', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    await expect(
      extractPptxText(Buffer.from(await zip.generateAsync({ type: 'uint8array' }))),
    ).rejects.toThrow(/no slides found/);
  });
});

describe('local-document provider — pptx', () => {
  it('dispatches by MIME and returns one text block', async () => {
    const buffer = await makePptx([textBox('幻灯片内容')]);
    const artifact = await officeDocumentExtractorProvider.extract({
      buffer,
      fileName: 'deck.pptx',
      fileSize: buffer.byteLength,
      mimeType: DOCUMENT_MIME_TYPES.pptx,
      config: { providerId: 'local-document' },
    });

    expect(artifact.blocks[0]).toMatchObject({
      type: 'text',
      text: '## Slide 1\n\n幻灯片内容',
    });
  });
});
