/**
 * Module-2 reference panel.
 *
 * The game widget prompt has no image variables, so a handoff game is generated
 * from text alone. Option B injects a collapsible "素材参考" drawer into the
 * finished game HTML: the source figures and the rasterized PDF pages stay
 * visible to the learner without changing the game mechanics.
 *
 * Pure and dependency-free on purpose: the generation preview calls it in the
 * browser, and a one-off repair script can import the same function with Node's
 * type stripping.
 */

export interface HandoffReferenceImage {
  id: string;
  src: string;
  pageNumber?: number;
  description?: string;
  width?: number;
  height?: number;
}

const PANEL_ID = 'maic-handoff-reference';
const MAX_LAYOUT_PAGES = 2;
const MAX_EMBEDDED_IMAGES = 6;
/** ~3 MB of base64 keeps the stored scene bounded. */
const MAX_TOTAL_DATA_URL_CHARS = 3_000_000;
/** Tiny logos and icons add noise, not reference value. */
const MIN_REFERENCE_EDGE_PX = 120;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function isLayoutImage(image: HandoffReferenceImage): boolean {
  return (image.description ?? '').startsWith('版式参考');
}

function isTiny(image: HandoffReferenceImage): boolean {
  if (!image.width || !image.height) return false;
  return Math.max(image.width, image.height) < MIN_REFERENCE_EDGE_PX;
}

function selectReferenceImages(images: readonly HandoffReferenceImage[]): {
  layout: HandoffReferenceImage[];
  embedded: HandoffReferenceImage[];
} {
  const usable = images.filter((image) => image.src?.startsWith('data:image') && !isTiny(image));
  const layout = usable
    .filter(isLayoutImage)
    .sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0))
    .slice(0, MAX_LAYOUT_PAGES);
  const embedded = usable
    .filter((image) => !isLayoutImage(image))
    .sort(
      (left, right) =>
        (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0),
    )
    .slice(0, MAX_EMBEDDED_IMAGES);

  const picked: HandoffReferenceImage[] = [];
  let totalChars = 0;
  for (const image of [...layout, ...embedded]) {
    if (totalChars + image.src.length > MAX_TOTAL_DATA_URL_CHARS) continue;
    picked.push(image);
    totalChars += image.src.length;
  }

  return {
    layout: picked.filter(isLayoutImage),
    embedded: picked.filter((image) => !isLayoutImage(image)),
  };
}

function captionFor(image: HandoffReferenceImage): string {
  const description = (image.description ?? '').trim();
  if (description) return description.slice(0, 80);
  return image.pageNumber ? `素材图片 · 第 ${image.pageNumber} 页` : '素材图片';
}

function figureHtml(image: HandoffReferenceImage): string {
  const caption = escapeHtml(captionFor(image));
  return (
    '<figure class="maic-ref-figure">' +
    `<img src="${escapeHtml(image.src)}" alt="${caption}" loading="lazy"/>` +
    `<figcaption>${caption}</figcaption>` +
    '</figure>'
  );
}

function panelHtml(images: readonly HandoffReferenceImage[]): string {
  const { layout, embedded } = selectReferenceImages(images);
  if (layout.length === 0 && embedded.length === 0) return '';

  const sections: string[] = [];
  if (embedded.length > 0) {
    sections.push(
      '<section class="maic-ref-section"><h3>设备图例</h3><div class="maic-ref-grid">' +
        embedded.map(figureHtml).join('') +
        '</div></section>',
    );
  }
  if (layout.length > 0) {
    sections.push(
      '<section class="maic-ref-section"><h3>版式参考</h3><div class="maic-ref-grid">' +
        layout.map(figureHtml).join('') +
        '</div></section>',
    );
  }

  return (
    `<details id="${PANEL_ID}" class="maic-ref">` +
    '<summary>素材参考</summary>' +
    `<div class="maic-ref-body">${sections.join('')}</div>` +
    '</details>' +
    '<style>' +
    `#${PANEL_ID}{position:fixed;right:12px;bottom:12px;z-index:2147483647;` +
    'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;' +
    'max-width:min(440px,calc(100vw - 24px));line-height:1.4}' +
    `#${PANEL_ID} summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;` +
    'background:rgba(8,24,40,.94);color:#d8ecff;border:1px solid rgba(120,180,255,.4);' +
    'border-radius:10px;padding:8px 12px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.35)}' +
    `#${PANEL_ID} summary::-webkit-details-marker{display:none}` +
    `#${PANEL_ID}[open] summary{border-radius:10px 10px 0 0}` +
    `#${PANEL_ID} .maic-ref-body{background:rgba(6,17,28,.97);border:1px solid rgba(120,180,255,.25);` +
    'border-top:none;border-radius:0 0 12px 12px;padding:10px;max-height:60vh;overflow:auto;' +
    'box-shadow:0 12px 32px rgba(0,0,0,.45)}' +
    `#${PANEL_ID} .maic-ref-section+.maic-ref-section{margin-top:10px}` +
    `#${PANEL_ID} h3{margin:0 0 6px;font-size:12px;font-weight:600;color:#9fc0d8;letter-spacing:.04em}` +
    `#${PANEL_ID} .maic-ref-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}` +
    `#${PANEL_ID} .maic-ref-figure{margin:0;min-width:0}` +
    `#${PANEL_ID} img{display:block;width:100%;height:110px;object-fit:contain;` +
    'background:#0b1a2a;border:1px solid rgba(120,180,255,.16);border-radius:6px}' +
    `#${PANEL_ID} figcaption{margin-top:4px;font-size:11px;color:#9fc0d8;` +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '</style>'
  );
}

/**
 * Append the reference drawer to a generated game document. Idempotent, and a
 * no-op when there is nothing worth showing.
 */
export function injectHandoffReferencePanel(
  html: string,
  images: readonly HandoffReferenceImage[],
): string {
  if (!html || html.includes(`id="${PANEL_ID}"`)) return html;
  const panel = panelHtml(images);
  if (!panel) return html;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, (closing) => `${panel}${closing}`);
  }
  return `${html}${panel}`;
}
