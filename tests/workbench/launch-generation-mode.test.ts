/**
 * The teaching-content mode on the message that CREATES a conversation.
 *
 * A workbench conversation is born in a mode and stays in it: the mode is
 * frozen onto the session row at creation and read back by the runner, which
 * states it in the system prompt and enforces it at page generation. There is
 * no second chance to change it, so what the composer sends on this one request
 * is the whole contract.
 *
 * What is pinned here: the wire shape, and that a `classic` request — the
 * default, and what every request this composer made before it had a picker
 * looked like — is byte-for-byte unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkbenchSession } from '@/lib/workbench/session-store';

const created = (extra: Record<string, unknown> = {}) => ({
  id: 's1',
  stageId: 'stage-1',
  status: 'queued',
  prompt: 'p',
  ...extra,
});

function stubFetch(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (fetchMock: ReturnType<typeof stubFetch>) =>
  JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('creating a session in a generation mode', () => {
  it.each(['single-game', 'multi-game'] as const)('sends %s as the canonical mode id', async (mode) => {
    const fetchMock = stubFetch(created());
    await createWorkbenchSession({ prompt: 'p', generationMode: mode });
    expect(bodyOf(fetchMock)).toEqual({ prompt: 'p', generationMode: mode });
  });

  it('leaves the body untouched for classic', async () => {
    // Absent, not "classic": the runner reads an absent mode as classic anyway,
    // and omitting keeps every request this composer made before the picker
    // existed byte-identical to what it is now.
    const explicit = stubFetch(created());
    await createWorkbenchSession({ prompt: 'p', generationMode: 'classic' });
    expect(bodyOf(explicit)).toEqual({ prompt: 'p' });
    expect(String((explicit.mock.calls[0][1] as RequestInit).body)).not.toContain('generationMode');

    const absent = stubFetch(created());
    await createWorkbenchSession({ prompt: 'p' });
    expect(String((absent.mock.calls[0][1] as RequestInit).body)).not.toContain('generationMode');
  });

  it('carries the mode alongside the other opening context', async () => {
    const courseRefs = [{ kind: 'course' as const, stageId: 'stage-1', title: '光的折射' }];
    const fetchMock = stubFetch(created({ courseRefs }));
    await createWorkbenchSession({ prompt: 'p', courseRefs, generationMode: 'multi-game' });

    expect(bodyOf(fetchMock)).toEqual({
      prompt: 'p',
      courseRefs,
      generationMode: 'multi-game',
    });
  });
});