import { Script } from 'node:vm';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

export interface InteractiveScriptSyntaxFailure {
  readonly scriptIndex: number;
  readonly message: string;
}

export type InteractiveScriptFailure =
  | ({
      readonly code: 'syntax';
    } & InteractiveScriptSyntaxFailure)
  | {
      readonly code: 'undefined-start-handler';
      readonly scriptIndex: null;
      readonly message: string;
    };

/**
 * Classic script type essences. Empty means the type attribute was omitted.
 * The rest are the JavaScript MIME type essences browsers still execute,
 * including legacy `x-` and `javascript1.x` names.
 */
const CLASSIC_JAVASCRIPT_TYPES = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

interface ScriptElement {
  readonly attributes: ReadonlyMap<string, string>;
  readonly source: string;
  /** False inside `<template>`: those scripts do not run until cloned. */
  readonly executable: boolean;
}

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.Element {
  return node.nodeName[0] !== '#';
}

function isTemplate(
  node: DefaultTreeAdapterTypes.Element,
): node is DefaultTreeAdapterTypes.Template {
  return node.tagName === 'template' && 'content' in node;
}

function isTextNode(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}

function scriptSource(element: DefaultTreeAdapterTypes.Element): string {
  let source = '';
  for (const child of element.childNodes) {
    if (isTextNode(child)) source += child.value;
  }
  return source;
}

function scriptAttributes(element: DefaultTreeAdapterTypes.Element): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, attribute.value);
  }
  return attributes;
}

/**
 * Script elements in tree order. parse5 applies HTML5 tokenization, including
 * script-data escaped and double-escaped states, so a `</script>` that is text
 * stays inside the body. Comments, raw text, and RCDATA do not contribute
 * scripts. Template contents are counted but not executable.
 */
function collectScripts(
  parent: DefaultTreeAdapterTypes.ParentNode,
  inTemplate: boolean,
  scripts: ScriptElement[],
): void {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName === 'script') {
      scripts.push({
        attributes: scriptAttributes(child),
        source: scriptSource(child),
        executable: !inTemplate,
      });
      continue;
    }
    if (isTemplate(child)) {
      collectScripts(child.content, true, scripts);
      continue;
    }
    collectScripts(child, inTemplate, scripts);
  }
}

function extractScriptElements(markup: string): ScriptElement[] {
  const scripts: ScriptElement[] = [];
  collectScripts(parse(markup), false, scripts);
  return scripts;
}

function hasInlineStartGameCall(parent: DefaultTreeAdapterTypes.ParentNode): boolean {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName === 'script' || isTemplate(child)) continue;
    for (const attribute of child.attrs) {
      if (
        attribute.name.toLowerCase().startsWith('on') &&
        /\bstartGame\s*\(\s*\)/.test(attribute.value)
      ) {
        return true;
      }
    }
    if (hasInlineStartGameCall(child)) return true;
  }
  return false;
}

function definesClassicStartGame(source: string): boolean {
  return (
    /\bfunction\s+startGame\s*\(/.test(source) ||
    /\b(?:var|let|const)\s+startGame\s*=(?!=)/.test(source) ||
    /\bstartGame\s*=(?!=)/.test(source)
  );
}

function definesModuleGlobalStartGame(source: string): boolean {
  return /\b(?:window|globalThis)\s*\.\s*startGame\s*=(?!=)/.test(source);
}

function hasUnknownExternalScript(scripts: readonly ScriptElement[]): boolean {
  return scripts.some((script) => {
    if (!script.executable || !script.attributes.has('src')) return false;
    const type = classicScriptType(script.attributes);
    return type === 'module' || CLASSIC_JAVASCRIPT_TYPES.has(type);
  });
}

function classicScriptType(attributes: ReadonlyMap<string, string>): string {
  const raw = (attributes.get('type') ?? '').trim().toLowerCase();
  // MIME parameters (`text/javascript; charset=utf-8`) are not part of the type.
  return raw.split(';', 1)[0]!.trim();
}

function isExecutableClassicInline(script: ScriptElement): boolean {
  if (!script.executable || script.attributes.has('src')) return false;
  return CLASSIC_JAVASCRIPT_TYPES.has(classicScriptType(script.attributes));
}

function classicScriptSyntaxError(source: string): string | null {
  try {
    // Compile as a classic Script. Never run the result.
    new Script(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Parse-check classic inline scripts without executing them.
 *
 * Script bodies come from parse5, so they match the HTML the browser would
 * run, including escaped and double-escaped script data. The grammar is a
 * classic Script, not a FunctionBody: top-level `return` is a syntax error.
 * `node:vm` `Script` compiles only; the result is never run.
 *
 * Data scripts, external scripts, and module scripts are skipped. `scriptIndex`
 * counts every parsed `<script>` element, including ones that are skipped.
 * Scripts HTML would not execute — comments, unparsed text, and `<template>` —
 * are not checked. Template scripts are still counted.
 */
export function findInteractiveScriptSyntaxFailure(
  html: string,
): InteractiveScriptSyntaxFailure | null {
  const scripts = extractScriptElements(html);
  for (let index = 0; index < scripts.length; index += 1) {
    const script = scripts[index]!;
    if (!isExecutableClassicInline(script) || !script.source.trim()) continue;
    const message = classicScriptSyntaxError(script.source);
    if (message) return { scriptIndex: index + 1, message };
  }
  return null;
}

/**
 * Reject the specific inert-widget shape we have observed from the model: an
 * inline start button calls `startGame()` but the generated script only defines
 * a differently named launcher. We intentionally limit this semantic check to
 * `startGame`; a broad event-handler parser would produce false positives for
 * inline form variables, `event`, and externally supplied handlers.
 *
 * External scripts are treated as unknown because their source is unavailable.
 * Syntax remains the first failure so a malformed script reports its exact
 * script index.
 */
export function findInteractiveScriptFailure(html: string): InteractiveScriptFailure | null {
  const syntaxFailure = findInteractiveScriptSyntaxFailure(html);
  if (syntaxFailure) return { code: 'syntax', ...syntaxFailure };

  if (!hasInlineStartGameCall(parse(html))) return null;
  const scripts = extractScriptElements(html);
  if (hasUnknownExternalScript(scripts)) return null;

  for (const script of scripts) {
    if (!script.executable) continue;
    const type = classicScriptType(script.attributes);
    if (script.attributes.has('src')) continue;
    if (type === 'module') {
      if (definesModuleGlobalStartGame(script.source)) return null;
      continue;
    }
    if (CLASSIC_JAVASCRIPT_TYPES.has(type) && definesClassicStartGame(script.source)) {
      return null;
    }
  }

  return {
    code: 'undefined-start-handler',
    scriptIndex: null,
    message: 'Inline startGame() handler is called, but no executable script defines it',
  };
}
