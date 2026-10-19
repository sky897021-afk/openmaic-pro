/**
 * Game-result runtime payload.
 *
 * A generated game page (generation mode ② single-game or ③ multi-game) ends a
 * session by posting `maic:game-result:v1` to its parent frame. The host
 * receives it in `InteractiveIframeHost` and appends it to the runtime store
 * under `GAME_RESULT_RUNTIME_KIND`.
 *
 * The WIRE format is baked into every already-generated course page and must
 * not change. This module describes what we STORE, which is the wire payload
 * plus a host-added `payloadVersion` so a future `:v2` message can be told
 * apart from this one.
 *
 * The payload comes from model-generated HTML and every field is
 * client-reported, so `normalizeGameResultPayload` is the only door in: it
 * settles the shape and the value ranges before anything reaches a store.
 */
import type { RuntimeRecord } from '@openmaic/dsl';

export const GAME_RESULT_RUNTIME_KIND = 'gameResult';
export const GAME_RESULT_PAYLOAD_VERSION = 1;
/** The `postMessage` type a game page emits. Fixed by the generation template. */
export const GAME_RESULT_MESSAGE_TYPE = 'maic:game-result:v1';

/**
 * Bounds on stored sizes. A model-authored page can report anything; these cap
 * one row so a runaway field cannot bloat the JSONB column.
 */
export const GAME_RESULT_MAX_GRADE_LENGTH = 64;
export const GAME_RESULT_MAX_MISTAKES = 50;
export const GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH = 280;
export const GAME_RESULT_MAX_ATTEMPTS = 10_000;
export const GAME_RESULT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export interface GameMistakeV1 {
  keyPoint: string;
  playerAction: string;
  correctAction: string;
  reason: string;
}

export interface GameResultPayloadV1 {
  payloadVersion: typeof GAME_RESULT_PAYLOAD_VERSION;
  /** Clamped to 0..100. */
  score: number;
  /** Clamped to 0..1. */
  accuracy: number;
  /** The model-authored, localized grade label, verbatim (length-capped). */
  grade: string;
  attempts: number;
  durationMs: number;
  mistakes: GameMistakeV1[];
}

export type GameResultRuntimeRecord = RuntimeRecord<GameResultPayloadV1>;

/**
 * One session per (stage, scene, learner); one appended record per finished
 * play, so history survives. `MAX(seq)` is the latest score. Segment-encoded
 * like `quizAttemptId` so a `:` inside an id cannot shift the fields.
 */
export function gameResultRuntimeSessionId(
  stageId: string,
  sceneId: string,
  learnerKey: string,
): string {
  return [
    'game-result',
    encodeURIComponent(stageId),
    encodeURIComponent(sceneId),
    encodeURIComponent(learnerKey),
  ].join(':');
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function clampCount(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

/** Drop unpaired surrogate halves — storage JSON encoders reject them. */
function stripUnpairedSurrogates(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index]! + value[index + 1]!;
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += value[index]!;
  }
  return out;
}

function truncateText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  // Truncation can cut a surrogate pair in half, so repair after slicing, not
  // before: `slice` operates on UTF-16 units.
  return stripUnpairedSurrogates(value.length <= maxLength ? value : value.slice(0, maxLength));
}

function normalizeMistakes(value: unknown): GameMistakeV1[] {
  if (!Array.isArray(value)) return [];
  const mistakes: GameMistakeV1[] = [];
  for (const candidate of value.slice(0, GAME_RESULT_MAX_MISTAKES)) {
    const entry = plainObject(candidate);
    if (!entry) continue;
    const keyPoint = truncateText(entry.keyPoint, GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH);
    const playerAction = truncateText(entry.playerAction, GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH);
    const correctAction = truncateText(entry.correctAction, GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH);
    const reason = truncateText(entry.reason, GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH);
    if (keyPoint === null || playerAction === null || correctAction === null || reason === null) {
      continue;
    }
    mistakes.push({ keyPoint, playerAction, correctAction, reason });
  }
  return mistakes;
}

/**
 * Settle an untrusted wire payload into the stored shape.
 *
 * Returns null when the result itself is unusable — a missing or non-numeric
 * `score`/`accuracy` is NOT defaulted, because a fabricated 0 would be a wrong
 * grade rather than a missing one. Secondary fields (grade, attempts,
 * durationMs, mistakes) degrade gracefully instead of discarding the result.
 */
export function normalizeGameResultPayload(raw: unknown): GameResultPayloadV1 | null {
  const value = plainObject(raw);
  if (!value) return null;
  const score = clampNumber(value.score, 0, 100);
  if (score === null) return null;
  const accuracy = clampNumber(value.accuracy, 0, 1);
  if (accuracy === null) return null;
  return {
    payloadVersion: GAME_RESULT_PAYLOAD_VERSION,
    score,
    accuracy,
    grade: truncateText(value.grade, GAME_RESULT_MAX_GRADE_LENGTH) ?? '',
    attempts: clampCount(value.attempts, GAME_RESULT_MAX_ATTEMPTS),
    durationMs: clampCount(value.durationMs, GAME_RESULT_MAX_DURATION_MS),
    mistakes: normalizeMistakes(value.mistakes),
  };
}
