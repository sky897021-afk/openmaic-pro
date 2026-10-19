import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  BrowserDocumentStore,
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
} from '@openmaic/storage';
import { HttpRuntimeStore, HttpRuntimeStoreError } from '@openmaic/storage/runtime/http';
import { createStorageHttpHandler } from '@openmaic/storage/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeGameResultPayload } from '@/lib/game/runtime/types';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

const NOW = '2026-10-16T00:00:00.000Z';

/** Exactly the shape a generated game page posts from its `endSession()`. */
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

function validPayload() {
  const payload = normalizeGameResultPayload(WIRE_RESULT);
  if (!payload) throw new Error('fixture must normalize');
  return payload;
}

function handlerFetch(handler: RequestListener): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries()),
      async *[Symbol.asyncIterator]() {
        if (body !== '') yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;
    return new Promise<Response>((resolve, reject) => {
      let status = 200;
      let headers: Record<string, string> = {};
      const fakeResponse = {
        get headersSent() {
          return false;
        },
        writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
          status = nextStatus;
          headers = nextHeaders ?? {};
          return this;
        },
        end(chunk?: string | Buffer) {
          resolve(
            new Response(status === 204 ? null : chunk?.toString(), {
              status,
              headers,
            }),
          );
          return this;
        },
        destroy(error?: Error) {
          reject(error ?? new Error('response destroyed'));
          return this;
        },
      } as unknown as ServerResponse;
      handler(fakeRequest, fakeResponse);
    });
  };
}

async function createGameResultSession(
  store: { createSession: BrowserRuntimeStore['createSession'] },
  id: string,
) {
  await store.createSession({
    id,
    kind: 'gameResult',
    stageId: 'stage-1',
    learnerKey: 'learner-1',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

describe('gameResult app payload wiring', () => {
  it('gates a gameResult session on the default app RuntimeStore', async () => {
    const { getRuntimeStore } = await import('@/lib/runtime/store');
    const store = getRuntimeStore();
    await createGameResultSession(store, 'gameResult-session');

    // The gate is keyed on the session's kind, so an unnormalized payload — the
    // shape a page would post if it skipped the host's normalizer — is refused.
    await expect(
      store.appendRecord({
        id: 'bad-game-result',
        sessionId: 'gameResult-session',
        createdAt: NOW,
        payload: { score: 87, grade: '良好' },
      }),
    ).rejects.toThrow('invalid runtime record');

    await expect(
      store.appendRecord(
        {
          id: 'game-result:first',
          sessionId: 'gameResult-session',
          sceneId: 'scene-1',
          createdAt: NOW,
          payload: validPayload(),
        },
        { expectedLastSeq: null },
      ),
    ).resolves.toMatchObject({ seq: 0, sceneId: 'scene-1' });

    // One session per (stage, scene, learner); every replay appends.
    await expect(
      store.appendRecord(
        {
          id: 'game-result:second',
          sessionId: 'gameResult-session',
          sceneId: 'scene-1',
          createdAt: NOW,
          payload: validPayload(),
        },
        { expectedLastSeq: 0 },
      ),
    ).resolves.toMatchObject({ seq: 1 });
  });

  it('enforces the same gameResult gate and CAS through HTTP', async () => {
    const runtime = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: 'game-result-http-wiring',
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const documents = new BrowserDocumentStore({ indexedDB: new IDBFactory() });
    const handler = createStorageHttpHandler(runtime, documents, {
      authenticate: async () => ({ learnerKey: 'learner-1' }),
      authorizeDocuments: async () => false,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const client = new HttpRuntimeStore({
      baseUrl: 'http://game-storage.invalid',
      fetch: handlerFetch(handler),
    });
    await createGameResultSession(client, 'http-game-result');

    await expect(
      client.appendRecord(
        {
          id: 'http-invalid',
          sessionId: 'http-game-result',
          createdAt: NOW,
          payload: { payloadVersion: 1, score: 87 },
        },
        { expectedLastSeq: null },
      ),
    ).rejects.toMatchObject({
      name: HttpRuntimeStoreError.name,
      status: 400,
      code: 'VALIDATION_FAILED',
    });

    await expect(
      client.appendRecord(
        {
          id: 'http-valid',
          sessionId: 'http-game-result',
          createdAt: NOW,
          payload: validPayload(),
        },
        { expectedLastSeq: null },
      ),
    ).resolves.toMatchObject({ seq: 0 });

    const stale = await client
      .appendRecord(
        {
          id: 'http-stale',
          sessionId: 'http-game-result',
          createdAt: NOW,
          payload: validPayload(),
        },
        { expectedLastSeq: null },
      )
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(RuntimeAppendConflictError);
    expect(stale).toMatchObject({
      name: RuntimeAppendConflictError.name,
      sessionId: 'http-game-result',
      expectedLastSeq: null,
      actualLastSeq: 0,
    });
  });
});
