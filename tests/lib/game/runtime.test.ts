import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, RuntimeAppendConflictError } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { recordGameResult } from '@/lib/game/runtime/record';
import {
  GAME_RESULT_MAX_GRADE_LENGTH,
  GAME_RESULT_MAX_MISTAKES,
  GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH,
  gameResultRuntimeSessionId,
  normalizeGameResultPayload,
} from '@/lib/game/runtime/types';
import { validateGameResultRuntimePayload } from '@/lib/game/runtime/validate';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

const NOW = '2026-10-16T00:00:00.000Z';
const LEARNER = 'openmaic-shared';

/** The wire shape a generated game page posts from its `endSession()`. */
const WIRE_RESULT = {
  score: 87,
  grade: '良好',
  accuracy: 0.75,
  attempts: 3,
  durationMs: 42_000,
  mistakes: [
    {
      keyPoint: '先算乘除',
      playerAction: '先算了加法',
      correctAction: '先算乘法',
      reason: '乘除优先级高于加减',
    },
  ],
};

function normalizedFixture() {
  const payload = normalizeGameResultPayload(WIRE_RESULT);
  if (!payload) throw new Error('fixture must normalize');
  return payload;
}

function createStore(dbName: string) {
  return new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
}

beforeEach(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

describe('normalizeGameResultPayload', () => {
  it('keeps the reported result and stamps the host-added payloadVersion', () => {
    expect(normalizedFixture()).toEqual({
      payloadVersion: 1,
      score: 87,
      accuracy: 0.75,
      grade: '良好',
      attempts: 3,
      durationMs: 42_000,
      mistakes: WIRE_RESULT.mistakes,
    });
  });

  it('clamps out-of-range numbers instead of trusting the page', () => {
    const payload = normalizeGameResultPayload({
      ...WIRE_RESULT,
      score: 150,
      accuracy: 2,
      attempts: -4,
      durationMs: Number.POSITIVE_INFINITY,
    });
    expect(payload).toMatchObject({ score: 100, accuracy: 1, attempts: 0, durationMs: 0 });
  });

  it('bounds the mistake list and each of its fields', () => {
    const payload = normalizeGameResultPayload({
      ...WIRE_RESULT,
      mistakes: Array.from({ length: 200 }, (_, index) => ({
        keyPoint: `kp-${index}`,
        playerAction: 'a'.repeat(500),
        correctAction: 'b',
        reason: 'c',
      })),
    });
    expect(payload?.mistakes).toHaveLength(GAME_RESULT_MAX_MISTAKES);
    expect(payload?.mistakes[0]?.playerAction).toHaveLength(GAME_RESULT_MAX_MISTAKE_FIELD_LENGTH);
  });

  it('never stores half a surrogate pair when a field is cut', () => {
    // 63 a's + one emoji is 65 UTF-16 units; cutting at 64 lands between the
    // surrogate halves, and a lone half is not encodable JSON text.
    const payload = normalizeGameResultPayload({
      ...WIRE_RESULT,
      grade: `${'a'.repeat(GAME_RESULT_MAX_GRADE_LENGTH - 1)}😀`,
      mistakes: [{ keyPoint: 'k', playerAction: 'p', correctAction: 'c', reason: 'r' }],
    });
    expect(payload).not.toBeNull();
    expect(payload!.grade).toBe('a'.repeat(GAME_RESULT_MAX_GRADE_LENGTH - 1));
    expect(payload!.grade).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(payload!.mistakes[0]?.reason).toBe('r');
  });

  it('drops malformed mistake entries but keeps the play', () => {
    const payload = normalizeGameResultPayload({
      ...WIRE_RESULT,
      mistakes: [{ keyPoint: 'k' }, null, 'nope', WIRE_RESULT.mistakes[0]],
    });
    expect(payload?.mistakes).toEqual([WIRE_RESULT.mistakes[0]]);
  });

  it('refuses to invent a score or an accuracy that the page never reported', () => {
    expect(normalizeGameResultPayload({ ...WIRE_RESULT, score: undefined })).toBeNull();
    expect(normalizeGameResultPayload({ ...WIRE_RESULT, score: '87' })).toBeNull();
    expect(normalizeGameResultPayload({ ...WIRE_RESULT, accuracy: null })).toBeNull();
    expect(normalizeGameResultPayload(null)).toBeNull();
    expect(normalizeGameResultPayload([WIRE_RESULT])).toBeNull();
  });
});

describe('validateGameResultRuntimePayload', () => {
  it('accepts a normalized payload and rejects everything else', () => {
    expect(validateGameResultRuntimePayload(normalizedFixture())).toEqual({ valid: true });
    expect(validateGameResultRuntimePayload({ ...normalizedFixture(), score: 101 }).valid).toBe(
      false,
    );
    expect(validateGameResultRuntimePayload({ ...normalizedFixture(), extra: true }).valid).toBe(
      false,
    );
    expect(validateGameResultRuntimePayload({ payloadVersion: 1 }).valid).toBe(false);
    expect(
      validateGameResultRuntimePayload({
        ...normalizedFixture(),
        mistakes: Array.from({ length: GAME_RESULT_MAX_MISTAKES + 1 }, () => ({
          keyPoint: 'k',
          playerAction: 'p',
          correctAction: 'c',
          reason: 'r',
        })),
      }).valid,
    ).toBe(false);
  });
});

describe('recordGameResult', () => {
  it('opens one session per (stage, scene, learner) and appends one record per play', async () => {
    const store = createStore('game-result-record');
    let minted = 0;
    const deps = {
      store,
      learnerKey: LEARNER,
      now: () => NOW,
      mintRecordId: () => `record-${(minted += 1)}`,
    };

    await recordGameResult(
      { stageId: 'stage-1', sceneId: 'scene-1', payload: normalizedFixture() },
      deps,
    );

    const sessionId = gameResultRuntimeSessionId('stage-1', 'scene-1', LEARNER);
    expect(sessionId).toBe(`game-result:stage-1:scene-1:${LEARNER}`);
    const session = await store.getSession(sessionId);
    expect(session).toMatchObject({
      kind: 'gameResult',
      stageId: 'stage-1',
      learnerKey: LEARNER,
      status: 'active',
    });

    const first = await store.listRecords(sessionId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ seq: 0, sceneId: 'scene-1', payload: normalizedFixture() });

    // A replay of the same scene appends to the SAME session — history, not upsert.
    const replay = normalizeGameResultPayload({ ...WIRE_RESULT, score: 55 });
    if (!replay) throw new Error('replay fixture must normalize');
    await recordGameResult({ stageId: 'stage-1', sceneId: 'scene-1', payload: replay }, deps);
    const records = await store.listRecords(sessionId);
    expect(records.map((record) => record.seq)).toEqual([0, 1]);
    expect(records.map((record) => (record.payload as { score: number }).score)).toEqual([87, 55]);
    expect(await store.listSessions('stage-1', LEARNER)).toHaveLength(1);
  });

  it('keeps levels apart: each scene gets its own session', async () => {
    const store = createStore('game-result-levels');
    const deps = { store, learnerKey: LEARNER, now: () => NOW };
    for (const sceneId of ['level-1', 'level-2']) {
      await recordGameResult({ stageId: 'stage-1', sceneId, payload: normalizedFixture() }, deps);
    }
    const sessions = await store.listSessions('stage-1', LEARNER);
    expect(sessions.map((session) => session.id).sort()).toEqual([
      `game-result:stage-1:level-1:${LEARNER}`,
      `game-result:stage-1:level-2:${LEARNER}`,
    ]);
  });

  it('retries the append when a concurrent writer wins the compare-and-swap', async () => {
    const store = createStore('game-result-contended');
    let injected = false;
    const contended = Object.create(store, {
      appendRecord: {
        value: async (init: Parameters<typeof store.appendRecord>[0], options: unknown) => {
          if (!injected) {
            injected = true;
            throw new RuntimeAppendConflictError(init.sessionId, null, 0);
          }
          return store.appendRecord(init, options as Parameters<typeof store.appendRecord>[1]);
        },
      },
    }) as typeof store;

    await recordGameResult(
      { stageId: 'stage-1', sceneId: 'scene-1', payload: normalizedFixture() },
      { store: contended, learnerKey: LEARNER, now: () => NOW },
    );

    expect(injected).toBe(true);
    const records = await store.listRecords(
      gameResultRuntimeSessionId('stage-1', 'scene-1', LEARNER),
    );
    expect(records.map((record) => record.seq)).toEqual([0]);
  });

  it('rejects a payload the storage gate would refuse', async () => {
    const store = createStore('game-result-invalid');
    await expect(
      recordGameResult(
        {
          stageId: 'stage-1',
          sceneId: 'scene-1',
          payload: { ...normalizedFixture(), score: 200 } as never,
        },
        { store, learnerKey: LEARNER, now: () => NOW },
      ),
    ).rejects.toThrow('score must be a finite number in 0..100');
  });
});
