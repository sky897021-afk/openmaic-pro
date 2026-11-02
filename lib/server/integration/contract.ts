/**
 * The integration contract: what a platform may send, and what this server
 * guarantees to accept.
 *
 * Deliberately strict at the boundary and forgiving about OPTIONAL fields. The
 * outline is the teacher's approved plan, so a malformed page is rejected with
 * the page index instead of being silently dropped; everything the platform
 * does not edit (`quizConfig`, `widgetType`, suggested media…) is carried
 * through untouched, because dropping it would quietly degrade generation.
 */
import type { SceneOutline } from '@/lib/types/generation';

/** The three creative shapes a classic (完整课程) course can build. */
const CLASSIC_SCENE_TYPES = new Set(['slide', 'quiz', 'interactive']);

const MAX_MATERIALS = 50;
export const MAX_MATERIAL_TEXT_CHARS = 200_000;
const MAX_MATERIAL_IDS = 20;
const MAX_OUTLINE_PAGES = 50;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_REQUIREMENT_CHARS = 20_000;
export const MAX_TENANT_CHARS = 100;
const MAX_LANGUAGE_DIRECTIVE_CHARS = 200;

export interface IntegrationMaterial {
  /** Platform-side resource id. Echoed in logs only; not persisted. */
  id?: string;
  title?: string;
  /** `docx` / `pdf` / `video` / … — descriptive only. */
  kind?: string;
  /** Text the platform extracted (or a transcript). Empty for title-only media. */
  text: string;
}

export interface IntegrationOptions {
  enableWebSearch?: boolean;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
}

export interface OutlineRequest {
  tenantId: string;
  externalCourseId?: string;
  externalChapterId?: string;
  requirement: string;
  /** Stored source materials created by `/outlines` or `/materials`. */
  materialIds?: string[];
  materialsText?: string;
  options: IntegrationOptions;
}

export interface CourseRequest extends OutlineRequest {
  outlines: SceneOutline[];
  courseTitle?: string;
  languageDirective?: string;
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; message: string };

function fail<T>(message: string): ContractResult<T> {
  return { ok: false, message };
}

function ok<T>(value: T): ContractResult<T> {
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  value: unknown,
  max: number,
  label: string,
): ContractResult<string | undefined> {
  if (value === undefined || value === null || value === '') return ok(undefined);
  if (typeof value !== 'string') return fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) return fail(`${label} must be at most ${max} characters`);
  return ok(trimmed || undefined);
}

function parseOptions(value: unknown): IntegrationOptions {
  if (!isRecord(value)) return {};
  const read = (name: keyof IntegrationOptions) =>
    typeof value[name] === 'boolean' ? (value[name] as boolean) : undefined;
  return {
    ...(read('enableWebSearch') !== undefined ? { enableWebSearch: read('enableWebSearch') } : {}),
    ...(read('enableImageGeneration') !== undefined
      ? { enableImageGeneration: read('enableImageGeneration') }
      : {}),
    ...(read('enableVideoGeneration') !== undefined
      ? { enableVideoGeneration: read('enableVideoGeneration') }
      : {}),
  };
}

/**
 * Turn the platform's per-resource text into the single `pdfContent.text`
 * block the classic pipeline consumes. Titles and kinds are kept as headers so
 * the model can tell two chapters apart; empty materials (a video with only a
 * title) contribute nothing rather than a dangling header.
 */
export function composeMaterialsText(materials: readonly IntegrationMaterial[]): string {
  const sections: string[] = [];
  materials.forEach((material, index) => {
    const text = material.text.trim();
    if (!text) return;
    const title = material.title?.trim() || `Material ${index + 1}`;
    const kind = material.kind?.trim();
    sections.push(`### ${title}${kind ? ` (${kind})` : ''}\n${text}`);
  });
  return sections.join('\n\n');
}

function parseMaterials(value: unknown): ContractResult<string | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!Array.isArray(value)) return fail('materials must be an array');
  if (value.length > MAX_MATERIALS) {
    return fail(`materials cannot contain more than ${MAX_MATERIALS} entries`);
  }
  const materials: IntegrationMaterial[] = [];
  let total = 0;
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) return fail(`materials[${index}] must be an object`);
    if (typeof raw.text !== 'string') return fail(`materials[${index}].text must be a string`);
    total += raw.text.length;
    if (total > MAX_MATERIAL_TEXT_CHARS) {
      return fail(`material text exceeds ${MAX_MATERIAL_TEXT_CHARS} characters`);
    }
    materials.push({
      ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
      text: raw.text,
    });
  }
  const text = composeMaterialsText(materials);
  return ok(text || undefined);
}

function parseMaterialIds(value: unknown): ContractResult<string[] | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!Array.isArray(value)) return fail('materialIds must be an array');
  if (value.length > MAX_MATERIAL_IDS) {
    return fail(`materialIds cannot contain more than ${MAX_MATERIAL_IDS} entries`);
  }

  const ids: string[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'string') return fail(`materialIds[${index}] must be a string`);
    const id = raw.trim();
    if (!/^mat_[A-Za-z0-9_-]{8,64}$/.test(id)) {
      return fail(`materialIds[${index}] is not a valid integration material id`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ok(ids.length ? ids : undefined);
}

/** Shared fields of both requests. */
function parseBase(body: unknown): ContractResult<{
  tenantId: string;
  requirement: string;
  materialIds?: string[];
  materialsText?: string;
  options: IntegrationOptions;
}> {
  if (!isRecord(body)) return fail('body must be a JSON object');

  const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : '';
  if (!tenantId) return fail('tenantId is required');
  if (tenantId.length > MAX_TENANT_CHARS) {
    return fail(`tenantId must be at most ${MAX_TENANT_CHARS} characters`);
  }

  const requirement = typeof body.requirement === 'string' ? body.requirement.trim() : '';
  if (!requirement) return fail('requirement is required');
  if (requirement.length > MAX_REQUIREMENT_CHARS) {
    return fail(`requirement must be at most ${MAX_REQUIREMENT_CHARS} characters`);
  }

  const materials = parseMaterials(body.materials);
  if (!materials.ok) return materials;
  const materialIds = parseMaterialIds(body.materialIds);
  if (!materialIds.ok) return materialIds;

  return ok({
    tenantId,
    requirement,
    ...(materialIds.value ? { materialIds: materialIds.value } : {}),
    ...(materials.value ? { materialsText: materials.value } : {}),
    options: parseOptions(body.options),
  });
}

export function parseOutlineRequest(body: unknown): ContractResult<OutlineRequest> {
  const base = parseBase(body);
  if (!base.ok) return base;

  const record = body as Record<string, unknown>;
  const externalCourseId = optionalString(record.externalCourseId, 200, 'externalCourseId');
  if (!externalCourseId.ok) return externalCourseId;
  const externalChapterId = optionalString(record.externalChapterId, 200, 'externalChapterId');
  if (!externalChapterId.ok) return externalChapterId;

  return ok({
    ...base.value,
    ...(externalCourseId.value ? { externalCourseId: externalCourseId.value } : {}),
    ...(externalChapterId.value ? { externalChapterId: externalChapterId.value } : {}),
  });
}

/**
 * Validate a teacher-approved outline.
 *
 * Order is honoured (sorted, then renumbered 1..n) so a platform that lets the
 * teacher drag pages does not have to renumber them itself. Any other field is
 * preserved verbatim — that is what keeps `quizConfig` / `widgetType` alive
 * through the edit round-trip.
 */
export function normalizeOutlines(value: unknown): ContractResult<SceneOutline[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return fail('outlines must be a non-empty array');
  }
  if (value.length > MAX_OUTLINE_PAGES) {
    return fail(`outlines cannot contain more than ${MAX_OUTLINE_PAGES} pages`);
  }

  const pages: SceneOutline[] = [];
  const usedIds = new Set<string>();

  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) return fail(`outlines[${index}] must be an object`);

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) return fail(`outlines[${index}].title is required`);
    if (title.length > MAX_TITLE_CHARS) {
      return fail(`outlines[${index}].title must be at most ${MAX_TITLE_CHARS} characters`);
    }

    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description) return fail(`outlines[${index}].description is required`);
    if (description.length > MAX_DESCRIPTION_CHARS) {
      return fail(
        `outlines[${index}].description must be at most ${MAX_DESCRIPTION_CHARS} characters`,
      );
    }

    const type = raw.type;
    if (typeof type !== 'string' || !CLASSIC_SCENE_TYPES.has(type)) {
      return fail(
        `outlines[${index}].type must be one of slide, quiz, interactive ` +
          '(a classic course does not contain PBL pages)',
      );
    }

    const order =
      typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index + 1;

    const keyPoints = Array.isArray(raw.keyPoints)
      ? raw.keyPoints
          .filter((point): point is string => typeof point === 'string')
          .map((point) => point.trim())
          .filter(Boolean)
      : [];

    const requestedId = typeof raw.id === 'string' ? raw.id.trim() : '';
    let id = requestedId && !usedIds.has(requestedId) ? requestedId : `outline_${index + 1}`;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `outline_${index + 1}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    pages.push({
      ...raw,
      id,
      title,
      description,
      type: type as SceneOutline['type'],
      order,
      keyPoints,
    } as SceneOutline);
  }

  pages.sort((left, right) => left.order - right.order);
  pages.forEach((page, index) => {
    page.order = index + 1;
  });

  return ok(pages);
}

export function parseCourseRequest(body: unknown): ContractResult<CourseRequest> {
  const base = parseBase(body);
  if (!base.ok) return base;

  const record = body as Record<string, unknown>;
  const outlines = normalizeOutlines(record.outlines);
  if (!outlines.ok) return outlines;

  const courseTitle = optionalString(record.courseTitle, MAX_TITLE_CHARS, 'courseTitle');
  if (!courseTitle.ok) return courseTitle;
  const languageDirective = optionalString(
    record.languageDirective,
    MAX_LANGUAGE_DIRECTIVE_CHARS,
    'languageDirective',
  );
  if (!languageDirective.ok) return languageDirective;
  const externalCourseId = optionalString(record.externalCourseId, 200, 'externalCourseId');
  if (!externalCourseId.ok) return externalCourseId;
  const externalChapterId = optionalString(record.externalChapterId, 200, 'externalChapterId');
  if (!externalChapterId.ok) return externalChapterId;

  return ok({
    ...base.value,
    outlines: outlines.value,
    ...(courseTitle.value ? { courseTitle: courseTitle.value } : {}),
    ...(languageDirective.value ? { languageDirective: languageDirective.value } : {}),
    ...(externalCourseId.value ? { externalCourseId: externalCourseId.value } : {}),
    ...(externalChapterId.value ? { externalChapterId: externalChapterId.value } : {}),
  });
}
