/**
 * The handoff → single-game session mapping.
 *
 * This is the contract between the module-2 landing page and OpenMAIC's
 * generation pipeline: text + layout digest in `pdfText`, embedded images and
 * page rasters in `pdfImages`, and a matching `imageMapping`. If this drifts,
 * the game is generated from the wrong material without any visible error.
 */
import { describe, expect, it } from 'vitest';

import {
  buildHandoffMaterialPreviews,
  buildHandoffGenerationSession,
  summarizeHandoffMaterials,
  type HandoffPayload,
} from '@/lib/integration/handoff-session';

function embedded(id: string) {
  return {
    id,
    src: `data:image/png;base64,${id}`,
    mimeType: 'image/png',
    order: 0,
    pageNumber: 2,
    width: 100,
    height: 50,
    kind: 'embedded' as const,
  };
}

function payload(overrides: Partial<HandoffPayload> = {}): HandoffPayload {
  return {
    handoff: {
      id: 'ho_test',
      prompt: '生成一个关于设备识别的单游戏互动资源',
      mode: 'single-game',
      completionToken: 'token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    materials: [
      {
        id: 'mat_a',
        fileName: 'a.pdf',
        text: 'PDF 文本',
        images: [embedded('img_1')],
        layout: {
          pageCount: 2,
          pages: [{ index: 1, src: 'data:image/png;base64,page1' }],
          summary: '2 page(s), 1 embedded image(s), 1 layout page raster(s)',
        },
      },
      {
        id: 'mat_b',
        fileName: 'b.docx',
        text: 'DOCX 文本',
        images: [embedded('docx_img_1')],
        layout: {
          blocks: [{ type: 'image', order: 0, imageId: 'docx_img_1' }],
          summary: '1 embedded image(s) in reading order',
        },
      },
    ],
    ...overrides,
  };
}

describe('buildHandoffGenerationSession', () => {
  it('pins the single-game mode and carries the prompt', () => {
    const session = buildHandoffGenerationSession(payload());

    expect(session.requirements).toEqual({
      requirement: '生成一个关于设备识别的单游戏互动资源',
      generationMode: 'single-game',
    });
    expect(session.currentStep).toBe('generating');
    expect(session.handoffId).toBe('ho_test');
    expect(typeof session.sessionId).toBe('string');
  });

  it('carries every material text and layout digest into pdfText', () => {
    const session = buildHandoffGenerationSession(payload());

    expect(session.pdfText).toContain('### a.pdf');
    expect(session.pdfText).toContain('PDF 文本');
    expect(session.pdfText).toContain('### 版式参考：a.pdf');
    expect(session.pdfText).toContain('2 page(s)');
    expect(session.pdfText).toContain('### b.docx');
    expect(session.pdfText).toContain('DOCX 文本');
  });

  it('maps embedded images and layout pages, with ids scoped to the material', () => {
    const session = buildHandoffGenerationSession(payload());

    expect(session.pdfImages.map((image) => image.id)).toEqual([
      'mat_a_img_1',
      'mat_a_layout_1',
      'mat_b_docx_img_1',
    ]);
    expect(Object.keys(session.imageMapping)).toEqual(session.pdfImages.map((image) => image.id));
    const page = session.pdfImages.find((image) => image.id === 'mat_a_layout_1');
    expect(page?.description).toContain('版式参考：a.pdf 第 1 页');
    expect(session.documentSources).toEqual([]);
    expect(session.imageStorageIds).toEqual([]);
  });

  it('caps the images handed to one generation', () => {
    const material = payload().materials[0];
    const session = buildHandoffGenerationSession(
      payload({
        materials: [
          {
            ...material,
            images: Array.from({ length: 40 }, (_unused, index) => embedded(`img_${index + 1}`)),
          },
        ],
      }),
    );

    expect(session.pdfImages).toHaveLength(30);
    expect(Object.keys(session.imageMapping)).toHaveLength(30);
  });
});

describe('summarizeHandoffMaterials', () => {
  it('reports text, embedded-image and layout-page counts', () => {
    expect(summarizeHandoffMaterials(payload())).toEqual({
      chars: 'PDF 文本'.length + 'DOCX 文本'.length,
      images: 2,
      layoutPages: 1,
    });
  });
});

describe('buildHandoffMaterialPreviews', () => {
  it('shows trimmed text with explicit truncation and an empty state', () => {
    const previews = buildHandoffMaterialPreviews(
      payload({
        materials: [
          {
            ...payload().materials[0],
            text: '  裂解工段操作说明  ',
          },
          {
            ...payload().materials[1],
            text: '   ',
            images: [],
            layout: {},
          },
        ],
      }),
      { textLimit: 4 },
    );

    expect(previews[0]).toMatchObject({
      textExcerpt: '裂解工段',
      textLength: 8,
      textTruncated: true,
    });
    expect(previews[1]).toMatchObject({
      textExcerpt: '',
      textLength: 0,
      textTruncated: false,
      embeddedImages: [],
      layoutPages: [],
    });
  });

  it('orders and caps each image kind while keeping the remaining counts', () => {
    const material = payload().materials[0];
    const previews = buildHandoffMaterialPreviews(
      payload({
        materials: [
          {
            ...material,
            images: [
              { ...embedded('img_3'), order: 3 },
              { ...embedded('img_1'), order: 1 },
              { ...embedded('img_2'), order: 2 },
            ],
            layout: {
              pages: [
                { index: 3, src: 'data:image/png;base64,page3' },
                { index: 1, src: 'data:image/png;base64,page1' },
                { index: 2, src: 'data:image/png;base64,page2' },
              ],
            },
          },
        ],
      }),
      { imageLimitPerKind: 2 },
    );

    expect(previews[0].embeddedImages.map((image) => image.id)).toEqual(['img_1', 'img_2']);
    expect(previews[0].hiddenEmbeddedImages).toBe(1);
    expect(previews[0].layoutPages.map((image) => image.label)).toEqual([
      '第 1 页版式',
      '第 2 页版式',
    ]);
    expect(previews[0].hiddenLayoutPages).toBe(1);
  });
});
