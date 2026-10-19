/**
 * Persist one finished game play.
 *
 * One runtime session per `(stageId, sceneId, learnerKey)` and one appended
 * record per play: history survives, and `MAX(seq)` is the latest score. In
 * mode ③ each level is its own scene, so each level appends its own record —
 * which is exactly what the generation template says the host owns ("the host
 * does the aggregating" for a level series).
 *
 * The session stays `active` forever so later plays can keep appending; unlike
 * a quiz attempt there is no terminal state to roll forward to.
 *
 * Callers treat this as fire-and-forget: never await it before the game's own
 * result screen is on the student's screen.
 */
import type { RuntimeSession } from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

import {
  GAME_RESULT_RUNTIME_KIND,
  gameResultRuntimeSessionId,
  type GameResultPayloadV1,
} from './types';
import { assertGameResultRuntimePayload } from './validate';

export interface RecordGameResultInput {
  stageId: string;
  sceneId: string;
  /** Already normalized by `normalizeGameResultPayload`; asserted again here. */
  payload: GameResultPayloadV1;
}

export interface GameResultRuntimeDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
  mintRecordId?: () => string;
  /** CAS retries before giving up on a contended append. */
  maxAppendAttempts?: number;
}

export const GAME_RESULT_APPEND_CONTENTION = 'GAME_RESULT_APPEND_CONTENTION';

const DEFAULT_MAX_APPEND_ATTEMPTS = 5;

function mintRecordId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `game-result-record:${suffix}`;
}

function assertSession(session: RuntimeSession, stageId: string, learnerKey: string): void {
  if (
    session.kind !== GAME_RESULT_RUNTIME_KIND ||
    session.stageId !== stageId ||
    session.learnerKey !== learnerKey
  ) {
    throw new Error(
      `Game-result session ${JSON.stringify(session.id)} does not belong to stage ` +
        `${JSON.stringify(stageId)} and learner ${JSON.stringify(learnerKey)}`,
    );
  }
}

async function ensureSession(
  store: RuntimeStore,
  sessionId: string,
  stageId: string,
  learnerKey: string,
  now: () => string,
): Promise<RuntimeSession> {
  const existing = await store.getSession(sessionId);
  if (existing) {
    assertSession(existing, stageId, learnerKey);
    return existing;
  }
  const timestamp = now();
  try {
    const created = await store.createSession({
      id: sessionId,
      kind: GAME_RESULT_RUNTIME_KIND,
      stageId,
      learnerKey,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    assertSession(created, stageId, learnerKey);
    return created;
  } catch (error) {
    // Another tab may win the deterministic create between our read and our
    // write; re-read the winner instead of losing this play.
    const winner = await store.getSession(sessionId);
    if (!winner) throw error;
    assertSession(winner, stageId, learnerKey);
    return winner;
  }
}

/**
 * Append one play. Rejects with `GAME_RESULT_APPEND_CONTENTION` when a
 * concurrent writer keeps winning the compare-and-swap.
 */
export async function recordGameResult(
  input: RecordGameResultInput,
  deps: GameResultRuntimeDeps = {},
): Promise<void> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const now = deps.now ?? (() => new Date().toISOString());
  const mintId = deps.mintRecordId ?? mintRecordId;
  const maxAttempts = deps.maxAppendAttempts ?? DEFAULT_MAX_APPEND_ATTEMPTS;

  assertGameResultRuntimePayload(input.payload);
  if (input.stageId.length === 0) throw new Error('GAME_RESULT_STAGE_ID_INVALID');
  if (input.sceneId.length === 0) throw new Error('GAME_RESULT_SCENE_ID_INVALID');
  if (learnerKey.length === 0) throw new Error('GAME_RESULT_LEARNER_KEY_INVALID');

  const sessionId = gameResultRuntimeSessionId(input.stageId, input.sceneId, learnerKey);
  await ensureSession(store, sessionId, input.stageId, learnerKey, now);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const records = await store.listRecords(sessionId);
    try {
      await store.appendRecord(
        {
          id: mintId(),
          sessionId,
          sceneId: input.sceneId,
          createdAt: now(),
          payload: input.payload,
        },
        { expectedLastSeq: records.at(-1)?.seq ?? null },
      );
      return;
    } catch (error) {
      if (error instanceof RuntimeAppendConflictError) continue;
      throw error;
    }
  }
  throw new Error(GAME_RESULT_APPEND_CONTENTION);
}
