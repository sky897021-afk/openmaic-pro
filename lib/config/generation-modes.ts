/**
 * The three generation modes, and the outline policy each one implies.
 *
 * A mode is a REQUEST-level fact: it travels in `UserRequirements.generationMode`
 * so a single deployment can serve all three at once (three entry links → three
 * modes), instead of the old process-level `OPENMAIC_SINGLE_GAME_MODE` env flag
 * that pinned the whole server to one shape.
 *
 *   classic      one teaching segment per scene (slide / quiz / interactive).
 *   single-game  exactly ONE scene holding the whole lesson as a single
 *                multi-stage teaching mini-game.
 *   multi-game   one game scene PER teaching objective — more material means
 *                more game pages. ("PBL": the classic segmentation, with every
 *                segment rendered as a game instead of a lesson page.)
 *
 * This module is imported by client components (the entry pages read the mode
 * out of the URL), so it must stay free of server-only imports. `PromptId` is
 * pulled in with `import type` only, which erases at compile time — importing
 * the prompt loader here would drag `node:fs` into the browser bundle.
 */

import type { PromptId } from '@/lib/prompts/types';
import type { GenerationMode, UserRequirements } from '@/lib/types/generation';

export const GENERATION_MODES = ['classic', 'single-game', 'multi-game'] as const;

export const DEFAULT_GENERATION_MODE: GenerationMode = 'classic';

/** URL segment for each mode: `/classic`, `/game`, `/games`. */
export const GENERATION_MODE_SLUGS: Readonly<Record<GenerationMode, string>> = {
  classic: 'classic',
  'single-game': 'game',
  'multi-game': 'games',
};

const SLUG_TO_MODE: Readonly<Record<string, GenerationMode>> = {
  classic: 'classic',
  'single-game': 'single-game',
  game: 'single-game',
  'multi-game': 'multi-game',
  games: 'multi-game',
  pbl: 'multi-game',
};

export function isGenerationMode(value: unknown): value is GenerationMode {
  return typeof value === 'string' && (GENERATION_MODES as readonly string[]).includes(value);
}

/**
 * Accepts a canonical mode id (`single-game`) or its short URL slug (`game`).
 * Returns null for anything unrecognised so callers can decide the fallback.
 */
export function parseGenerationMode(value: unknown): GenerationMode | null {
  if (isGenerationMode(value)) return value;
  if (typeof value !== 'string') return null;
  return SLUG_TO_MODE[value.trim().toLowerCase()] ?? null;
}

/**
 * Deployment-level fallback for requests that carry no mode at all — the
 * sidebar for programmatic/API callers and for older clients. Mirrors the flag
 * 3003 has been running on; unset means classic.
 */
export function envFallbackGenerationMode(): GenerationMode {
  return process.env.OPENMAIC_SINGLE_GAME_MODE === 'true' ? 'single-game' : DEFAULT_GENERATION_MODE;
}

/**
 * The mode a request runs in: explicit `generationMode` wins, otherwise the
 * deployment fallback. Unrecognised values are ignored rather than rejected so
 * a stale client can never hard-fail generation.
 */
export function resolveGenerationMode(
  requirements?: Pick<UserRequirements, 'generationMode'> | null,
): GenerationMode {
  return parseGenerationMode(requirements?.generationMode) ?? envFallbackGenerationMode();
}

/**
 * Declarative outline policy for a mode. The route reads this instead of
 * branching on env flags, so adding a fourth mode means adding a row here.
 */
export interface OutlinePolicy {
  mode: GenerationMode;
  /**
   * File prompt to build stage 1 with. `null` means "use the bundled classic
   * outline builder from `@openmaic/generation`" — the default path that the
   * route already starts from.
   */
  promptId: PromptId | null;
  /** Force every surviving scene to `interactive` / `widgetType: 'game'`. */
  forceGameScenes: boolean;
  /** Hard cap on the final scene count. `undefined` = the model decides. */
  maxScenes?: number;
  /**
   * Stream only the first parsed scene to the client. Single-game packs the
   * whole lesson into one page, so extra streamed scenes would flash pages the
   * finaliser then discards.
   */
  streamFirstSceneOnly: boolean;
}

const POLICIES: Readonly<Record<GenerationMode, OutlinePolicy>> = {
  classic: {
    mode: 'classic',
    promptId: null,
    forceGameScenes: false,
    streamFirstSceneOnly: false,
  },
  'single-game': {
    mode: 'single-game',
    promptId: 'single-game-outlines',
    forceGameScenes: true,
    maxScenes: 1,
    streamFirstSceneOnly: true,
  },
  'multi-game': {
    // Segments the material by teaching objective and emits one game scene per
    // objective, so more material means more pages. The prompt is the source of
    // the segmentation; `coerceToGameOutlines` is only the hard guarantee that
    // every surviving scene really is a game.
    mode: 'multi-game',
    promptId: 'multi-game-outlines',
    forceGameScenes: true,
    streamFirstSceneOnly: false,
  },
};

export function resolveOutlinePolicy(mode: GenerationMode): OutlinePolicy {
  return POLICIES[mode] ?? POLICIES[DEFAULT_GENERATION_MODE];
}
