import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportHandoffResult, storeHandoffSession } from '@/lib/integration/handoff-client';

const HANDOFF_ID = 'ho_test_handoff';
const COMPLETION_TOKEN = 'completion-token';
const HANDOFF_ID_KEY = 'maic:integration-handoff-id';
const HANDOFF_TOKEN_KEY = 'maic:integration-handoff-token';

function createSessionStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe('reportHandoffResult', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createSessionStorage();
    vi.stubGlobal('window', {});
    vi.stubGlobal('sessionStorage', storage);
    storeHandoffSession(HANDOFF_ID, COMPLETION_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the completion capability after a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));

    await expect(reportHandoffResult('stage_123456')).resolves.toBeUndefined();

    expect(storage.getItem(HANDOFF_ID_KEY)).toBe(HANDOFF_ID);
    expect(storage.getItem(HANDOFF_TOKEN_KEY)).toBe(COMPLETION_TOKEN);
  });

  it('keeps the completion capability after a retryable server response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(reportHandoffResult('stage_123456')).resolves.toBeUndefined();

    expect(storage.getItem(HANDOFF_ID_KEY)).toBe(HANDOFF_ID);
    expect(storage.getItem(HANDOFF_TOKEN_KEY)).toBe(COMPLETION_TOKEN);
  });

  it('clears the completion capability only after a successful report', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reportHandoffResult('stage_123456')).resolves.toBeUndefined();

    expect(storage.getItem(HANDOFF_ID_KEY)).toBeNull();
    expect(storage.getItem(HANDOFF_TOKEN_KEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration/v1/handoffs/${HANDOFF_ID}/result`,
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({
          completionToken: COMPLETION_TOKEN,
          stageId: 'stage_123456',
        }),
      }),
    );
  });
});
