/**
 * Structural gate for the `gameResult` runtime payload.
 *
 * This runs at the storage write seam (see `APP_RUNTIME_PAYLOAD_VALIDATORS`),
 * where a validator may only accept or reject — clamping here would make the
 * write boundary silently mutate data, so range repair lives in
 * `normalizeGameResultPayload` instead and this gate is deliberately strict
 * about what it lets through.
 */
import type { RuntimePayloadValidator } from '@openmaic/storage';

import {
  GAME_RESULT_MAX_ATTEMPTS,
  GAME_RESULT_MAX_DURATION_MS,
  GAME_RESULT_MAX_GRADE_LENGTH,
  GAME_RESULT_MAX_MISTAKES,
  GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH,
  GAME_RESULT_PAYLOAD_VERSION,
  type GameResultPayloadV1,
} from './types';

const PAYLOAD_KEYS = new Set([
  'payloadVersion',
  'score',
  'accuracy',
  'grade',
  'attempts',
  'durationMs',
  'mistakes',
]);
const MISTAKE_KEYS = new Set(['keyPoint', 'playerAction', 'correctAction', 'reason']);

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function assertMistake(entry: unknown): void {
  const mistake = plainObject(entry);
  if (!mistake || !hasExactOwnKeys(mistake, MISTAKE_KEYS)) {
    throw new Error('mistakes contains an invalid entry');
  }
  if (
    !isText(mistake.keyPoint, GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH) ||
    !isText(mistake.playerAction, GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH) ||
    !isText(mistake.correctAction, GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH) ||
    !isText(mistake.reason, GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH)
  ) {
    throw new Error('mistakes contains an invalid entry');
  }
}

export function assertGameResultRuntimePayload(
  payload: unknown,
): asserts payload is GameResultPayloadV1 {
  const value = plainObject(payload);
  if (!value || !hasExactOwnKeys(value, PAYLOAD_KEYS)) throw new Error('payload keys are invalid');
  if (value.payloadVersion !== GAME_RESULT_PAYLOAD_VERSION) {
    throw new Error(`payloadVersion must be ${GAME_RESULT_PAYLOAD_VERSION}`);
  }
  if (!isNumberInRange(value.score, 0, 100)) {
    throw new Error('score must be a finite number in 0..100');
  }
  if (!isNumberInRange(value.accuracy, 0, 1)) {
    throw new Error('accuracy must be a finite number in 0..1');
  }
  if (!isText(value.grade, GAME_RESULT_MAX_GRADE_LENGTH)) throw new Error('grade is invalid');
  if (!isIntegerInRange(value.attempts, 0, GAME_RESULT_MAX_ATTEMPTS)) {
    throw new Error('attempts must be an integer in 0..10000');
  }
  if (!isIntegerInRange(value.durationMs, 0, GAME_RESULT_MAX_DURATION_MS)) {
    throw new Error('durationMs must be an integer in 0..86400000');
  }
  if (!Array.isArray(value.mistakes) || value.mistakes.length > GAME_RESULT_MAX_MISTAKES) {
    throw new Error('mistakes must be an array of at most 50 entries');
  }
  for (const entry of value.mistakes) assertMistake(entry);
}

export function validateGameResultRuntimePayload(
  payload: unknown,
): { valid: true } | { valid: false; errors: { path: string; message: string }[] } {
  try {
    assertGameResultRuntimePayload(payload);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      errors: [
        { path: '/payload', message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}

export const gameResultRuntimePayloadValidator: RuntimePayloadValidator =
  validateGameResultRuntimePayload;
