/**
 * ②'s one-page guarantee, for when the model refuses to cooperate.
 *
 * Mode ② asks for exactly one scene — the prompt says so in three places — but a
 * model handed a long document still sometimes answers with a whole
 * course-shaped list: introduction, chapters, summary. The finaliser used to
 * keep one of those scenes and drop the rest without a trace, which is
 * indistinguishable, from the outside, from ② genuinely producing a thin page.
 * (The prompt alone cannot close that gap: a list that arrives politely is
 * exactly the case where "the model followed the contract" and "the model
 * ignored it" look the same.)
 *
 * So the surplus is condensed instead: ONE extra model call merges it into the
 * single allowed scene, and that call must return a disposition for **every**
 * input scene. Content can then only leave the pipeline by being *declared* —
 * folded into the game, redundant with something already folded, or carrying no
 * teachable content at all — never by being ignored.
 *
 * The exchange rate is deliberately lopsided. One retry, then a mechanical
 * merge in code: the worst case is a page built from every scene, rather than a
 * page built from whichever one the model happened to put first.
 *
 * Nothing here is server-specific; the caller supplies the model round-trip.
 */
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import type { SceneOutline, UserRequirements, WidgetOutline } from '@/lib/types/generation';

/** Two attempts: the call, and one named retry. */
const MAX_CONDENSE_ATTEMPTS = 2;

/**
 * Key points per input scene handed to the condenser. Scenes declare two to
 * five; six is headroom for a model that overran, and the cap keeps the prompt
 * bounded when a runaway list arrives.
 */
const SOURCE_KEY_POINTS_PER_SCENE = 6;

/** Merge ceiling. Beyond this the page stops being one game. */
const MERGED_KEY_POINT_LIMIT = 12;

const MAX_DESCRIPTION_CHARS = 400;

export const DISPOSITIONS = ['folded', 'redundant', 'non-teaching'] as const;

export type SceneDisposition = (typeof DISPOSITIONS)[number];

export interface DispositionEntry {
  /** 1-based position of the input scene this disposition is about. */
  index: number;
  disposition: SceneDisposition;
  /** The model's own one-liner: what was carried, or why nothing was. */
  note: string;
}

export type DispositionCheck =
  | { ok: true; entries: DispositionEntry[] }
  | { ok: false; problems: string[] };

// ---------------------------------------------------------------------------
// Shape helpers — the condenser's output is model text, so every field is
// re-validated rather than trusted.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}

function asTextList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asText(item, MAX_DESCRIPTION_CHARS))
    .filter((item): item is string => item !== null)
    .slice(0, maxItems);
}

const GAME_TYPES: ReadonlySet<NonNullable<WidgetOutline['gameType']>> = new Set([
  'quiz',
  'puzzle',
  'strategy',
  'card',
  'action',
]);

function asWidgetOutline(value: unknown): WidgetOutline | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const outline: WidgetOutline = {};
  const concept = asText(record.concept, MAX_DESCRIPTION_CHARS);
  if (concept) outline.concept = concept;
  const challenge = asText(record.challenge, MAX_DESCRIPTION_CHARS);
  if (challenge) outline.challenge = challenge;
  const controls = asTextList(record.playerControls, 8);
  if (controls.length) outline.playerControls = controls;

  const gameType = record.gameType;
  if (
    typeof gameType === 'string' &&
    GAME_TYPES.has(gameType as NonNullable<WidgetOutline['gameType']>)
  ) {
    outline.gameType = gameType as NonNullable<WidgetOutline['gameType']>;
  }

  return Object.keys(outline).length ? outline : undefined;
}

/**
 * Locate the JSON object in a model response: the response itself, a fenced
 * block inside it, or the outermost `{…}` span. Models wrap a perfectly good
 * object in a sentence often enough that rejecting it would burn the retry on
 * formatting rather than on a missing disposition.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Not this one.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The disposition table
// ---------------------------------------------------------------------------

/**
 * The rule that makes the condenser worth its call: every input scene is
 * accounted for, exactly once.
 *
 * Note what is deliberately NOT required — that every scene be `folded`. A
 * course-shaped list really does contain a summary page and an agenda; forcing
 * those into the one game would be padding, not fidelity. The guarantee is
 * coverage of the *table*, so a scene can be set aside only by naming why.
 */
export function checkDispositions(raw: unknown, sceneCount: number): DispositionCheck {
  if (!Array.isArray(raw)) return { ok: false, problems: ['is missing or is not an array.'] };

  const problems: string[] = [];
  if (raw.length !== sceneCount) {
    problems.push(
      `must hold exactly ${sceneCount} ${sceneCount === 1 ? 'entry' : 'entries'} — one per input scene (found ${raw.length}).`,
    );
  }

  const entries: DispositionEntry[] = [];
  const seen = new Set<number>();

  for (const item of raw) {
    const record = asRecord(item);
    if (!record) {
      problems.push('contains an entry that is not an object.');
      continue;
    }
    const index = record.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > sceneCount) {
      problems.push(
        `has an entry with an index outside 1..${sceneCount} (${JSON.stringify(index)}).`,
      );
      continue;
    }
    if (seen.has(index)) {
      problems.push(`repeats index ${index}.`);
      continue;
    }
    seen.add(index);

    const disposition = record.disposition;
    if (
      typeof disposition !== 'string' ||
      !(DISPOSITIONS as readonly string[]).includes(disposition)
    ) {
      problems.push(
        `marks scene ${index} with an unknown disposition (${JSON.stringify(disposition)}); use one of ${DISPOSITIONS.join(' / ')}.`,
      );
      continue;
    }

    const note = asText(record.note, 300);
    if (!note) {
      problems.push(`has no \`note\` for scene ${index}; every entry needs one.`);
      continue;
    }

    entries.push({ index, disposition: disposition as SceneDisposition, note });
  }

  const missing: number[] = [];
  for (let index = 1; index <= sceneCount; index++) if (!seen.has(index)) missing.push(index);
  if (missing.length) problems.push(`has no entry for scene ${missing.join(', ')}.`);

  if (!problems.length && !entries.some((entry) => entry.disposition === 'folded')) {
    problems.push('marks no scene as `folded`: the one game has to carry something.');
  }

  return problems.length ? { ok: false, problems } : { ok: true, entries };
}

/** `folded 2, non-teaching 1` — the outcome line, for the caller's log. */
export function summarizeDispositions(entries: DispositionEntry[]): string {
  const counts = new Map<SceneDisposition, number>();
  for (const entry of entries)
    counts.set(entry.disposition, (counts.get(entry.disposition) ?? 0) + 1);
  return DISPOSITIONS.filter((disposition) => counts.has(disposition))
    .map((disposition) => `${disposition} ${counts.get(disposition)}`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// The condensed scene
// ---------------------------------------------------------------------------

/** The condenser's `outline`, or why it was unusable. */
export type CondensedSceneRead = { ok: true; scene: SceneOutline } | { ok: false; problem: string };

/**
 * Read the condenser's `outline` into a scene.
 *
 * Built field by field rather than spread, which is what keeps `order` /
 * `seriesIndex` / `seriesTotal` out of it: ② is one whole-lesson game, and a
 * stray `seriesTotal` makes the game-content template render it as 「第 k / N
 * 关」.
 *
 * Rejections say which field was missing, because the message goes straight
 * back to the model as the correction: "the outline was unusable" buys a retry
 * that fixes nothing.
 */
export function readCondensedScene(raw: unknown): CondensedSceneRead {
  const record = asRecord(raw);
  if (!record) return { ok: false, problem: '`outline` is missing or is not an object.' };

  const title = asText(record.title, 200);
  if (!title) return { ok: false, problem: '`outline.title` is missing or empty.' };

  const description = asText(record.description, 800);
  if (!description) return { ok: false, problem: '`outline.description` is missing or empty.' };

  const keyPoints = asTextList(record.keyPoints, 5);
  if (!keyPoints.length) {
    return {
      ok: false,
      problem:
        '`outline.keyPoints` holds no non-empty string, so the game has nothing to be scored against.',
    };
  }

  const widgetOutline = asWidgetOutline(record.widgetOutline);

  return {
    ok: true,
    scene: {
      id: 'game-1',
      order: 1,
      type: 'interactive',
      widgetType: 'game',
      title,
      description,
      keyPoints,
      ...(widgetOutline ? { widgetOutline } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The mechanical fallback
// ---------------------------------------------------------------------------

export interface MechanicalMerge {
  outline: SceneOutline;
  /** How many source scenes contributed at least one key point. */
  coveredScenes: number;
  /** Key points the merge could not carry (duplicates or past the ceiling). */
  droppedKeyPoints: number;
}

/**
 * Last resort: build the one page out of the source scenes with code only.
 *
 * Round-robin, one key point per scene per pass, so every scene that has
 * anything to say is heard before any scene is heard twice — the coverage
 * property the condenser is held to, obtained without a model. The result is
 * poor as a *game* (nothing designed it) but it is not an excerpt: the caller
 * must log it as a degraded outcome.
 */
export function mergeOutlinesMechanically(
  outlines: SceneOutline[],
  requirements: UserRequirements,
): MechanicalMerge {
  const pools = outlines.map((outline) =>
    (outline.keyPoints ?? []).map((point) => point.trim()).filter(Boolean),
  );
  const totalPoints = pools.reduce((sum, pool) => sum + pool.length, 0);

  const merged: string[] = [];
  const seen = new Set<string>();
  const contributed = new Set<number>();

  for (let pass = 0; merged.length < MERGED_KEY_POINT_LIMIT; pass++) {
    let anyPoolHadMore = false;
    for (let scene = 0; scene < pools.length; scene++) {
      if (merged.length >= MERGED_KEY_POINT_LIMIT) break;
      const point = pools[scene][pass];
      if (point === undefined) continue;
      anyPoolHadMore = true;
      const key = point.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(point);
      contributed.add(scene);
    }
    if (!anyPoolHadMore) break;
  }

  const title =
    outlines.map((outline) => outline.title?.trim()).find((value) => !!value) ??
    requirements.requirement.trim().slice(0, 40);

  return {
    outline: {
      id: 'game-1',
      order: 1,
      type: 'interactive',
      widgetType: 'game',
      title,
      // Left empty on purpose: `toGameScene` fills it from the requirement,
      // which is the only description of the merged page that is not a lie
      // about one particular source scene.
      description: '',
      keyPoints: merged.length ? merged : [requirements.requirement],
    },
    coveredScenes: contributed.size,
    droppedKeyPoints: Math.max(0, totalPoints - merged.length),
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface CondenseArgs {
  /** The model's over-long list. Must hold at least two scenes. */
  outlines: SceneOutline[];
  requirements: UserRequirements;
  /** The directive the first pass already streamed; context for phrasing. */
  languageDirective: string;
  /** One round-trip to the model. Throws on transport failure. */
  runModel: (prompt: { system: string; user: string }) => Promise<string>;
}

export type CondenseOutcome =
  | { ok: true; scene: SceneOutline; dispositions: DispositionEntry[]; attempts: number }
  | {
      ok: false;
      reason: 'prompt-unavailable' | 'model-error' | 'invalid-output';
      detail: string;
      attempts: number;
    };

/** The compact view of a scene: what it was asked to teach, not how it serialized. */
function toCondenseSource(outline: SceneOutline, index: number) {
  return {
    index: index + 1,
    type: outline.type,
    title: outline.title,
    ...(outline.teachingObjective ? { teachingObjective: outline.teachingObjective } : {}),
    description: (outline.description ?? '').slice(0, MAX_DESCRIPTION_CHARS),
    keyPoints: (outline.keyPoints ?? []).slice(0, SOURCE_KEY_POINTS_PER_SCENE),
  };
}

export async function condenseOutlines(args: CondenseArgs): Promise<CondenseOutcome> {
  const sceneCount = args.outlines.length;
  const scenes = args.outlines.map(toCondenseSource);

  let correction = '';
  for (let attempt = 1; attempt <= MAX_CONDENSE_ATTEMPTS; attempt++) {
    const prompts = buildPrompt(PROMPT_IDS.SINGLE_GAME_CONDENSE, {
      requirement: args.requirements.requirement,
      languageDirective: args.languageDirective,
      sceneCount,
      scenes,
      correction,
    });
    if (!prompts) {
      return {
        ok: false,
        reason: 'prompt-unavailable',
        detail: 'single-game-condense template could not be loaded',
        attempts: attempt,
      };
    }

    let text: string;
    try {
      text = await args.runModel(prompts);
    } catch (error) {
      return {
        ok: false,
        reason: 'model-error',
        detail: error instanceof Error ? error.message : String(error),
        attempts: attempt,
      };
    }

    const record = asRecord(extractJsonObject(text));
    if (!record) {
      correction = 'The response was not a JSON object with `outline` and `dispositions`.';
      continue;
    }

    const read = readCondensedScene(record.outline);
    const check = checkDispositions(record.dispositions, sceneCount);
    if (read.ok && check.ok) {
      return { ok: true, scene: read.scene, dispositions: check.entries, attempts: attempt };
    }

    const problems: string[] = [];
    if (!read.ok) problems.push(read.problem);
    if (!check.ok) problems.push(...check.problems.map((problem) => `\`dispositions\` ${problem}`));
    correction = problems.join(' ');
  }

  return {
    ok: false,
    reason: 'invalid-output',
    detail: correction || 'the condenser never produced a usable object',
    attempts: MAX_CONDENSE_ATTEMPTS,
  };
}
