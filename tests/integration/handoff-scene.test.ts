/**
 * The handoff reference drawer (option B).
 *
 * The game prompt cannot reference images, so the finished game gets a
 * collapsible panel with the source figures and rasterized pages. These tests
 * pin the selection caps, the injection point, escaping, and idempotence.
 */
import { describe, expect, it } from 'vitest';

import {
  injectHandoffReferencePanel,
  type HandoffReferenceImage,
} from '@/lib/integration/handoff-scene';

function image(id: string, overrides: Partial<HandoffReferenceImage> = {}): HandoffReferenceImage {
  return {
    id,
    src: `data:image/png;base64,${id}`,
    description: `图 ${id}`,
    width: 600,
    height: 400,
    ...overrides,
  };
}

function layoutImage(index: number): HandoffReferenceImage {
  return image(`layout_${index}`, {
    description: `版式参考：第 ${index} 页`,
    pageNumber: index,
    width: 800,
    height: 1200,
  });
}

const HTML = '<!DOCTYPE html><html><body><div id="game">game</div></body></html>';

describe('injectHandoffReferencePanel', () => {
  it('is a no-op without usable images', () => {
    expect(injectHandoffReferencePanel(HTML, [])).toBe(HTML);
  });

  it('injects a drawer with figures and layout pages before </body>', () => {
    const html = injectHandoffReferencePanel(HTML, [image('img_1'), layoutImage(1)]);

    expect(html).toContain('id="maic-handoff-reference"');
    expect(html).toContain('<summary>素材参考</summary>');
    expect(html).toContain('设备图例');
    expect(html).toContain('版式参考');
    expect(html).toContain('data:image/png;base64,img_1');
    expect(html).toContain('data:image/png;base64,layout_1');
    expect(html.indexOf('maic-handoff-reference')).toBeLessThan(html.indexOf('</body>'));
    expect(html).toContain('<div id="game">game</div>');
  });

  it('appends when the document has no body element', () => {
    const html = injectHandoffReferencePanel('<div id="game"></div>', [image('img_1')]);
    expect(html.startsWith('<div id="game"></div>')).toBe(true);
    expect(html).toContain('id="maic-handoff-reference"');
  });

  it('skips tiny logos and icons', () => {
    const tiny = image('tiny', { width: 48, height: 48 });
    expect(injectHandoffReferencePanel(HTML, [tiny])).toBe(HTML);
  });

  it('caps the drawer at six figures and two layout pages', () => {
    const images = [
      ...Array.from({ length: 40 }, (_unused, index) => image(`img_${index + 1}`)),
      ...Array.from({ length: 3 }, (_unused, index) => layoutImage(index + 1)),
    ];
    const html = injectHandoffReferencePanel(HTML, images);
    const figureCount = html.split('<figure').length - 1;

    expect(figureCount).toBe(8);
    expect(html).toContain('data:image/png;base64,layout_1');
    expect(html).toContain('data:image/png;base64,layout_2');
    expect(html).not.toContain('data:image/png;base64,layout_3');
  });

  it('stops adding images once the data-URL budget is reached', () => {
    const big = (id: string) =>
      image(id, { src: `data:image/png;base64,${'A'.repeat(1_200_000)}` });
    const html = injectHandoffReferencePanel(HTML, [big('a'), big('b'), big('c')]);
    expect(html.split('<figure').length - 1).toBe(2);
  });

  it('escapes a caption instead of injecting markup', () => {
    const evil = image('img_1', { description: '"><script>alert(1)</script>' });
    const html = injectHandoffReferencePanel(HTML, [evil]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not inject twice', () => {
    const once = injectHandoffReferencePanel(HTML, [image('img_1')]);
    expect(injectHandoffReferencePanel(once, [image('img_1')])).toBe(once);
  });
});
