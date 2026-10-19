/**
 * ②'s reducer, wired end to end through the real route.
 *
 * The unit tests in `tests/server/single-game-condense.test.ts` pin what the
 * condenser does with a model response. This file pins the part they cannot:
 * that the ROUTE actually reaches it — that a `single-game` request whose model
 * returns three scenes ends with one page built from all three, that a request
 * whose model behaves costs no extra call, and that a failing condenser still
 * produces a page rather than an excerpt.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const streamLLMMock = vi.hoisted(() => vi.fn());
const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: streamLLMMock,
  callLLM: callLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

async function readStreamBody(response: Response) {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let text = '';

  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  return text;
}

function parseSseEvents(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

function mockRequest(requirements: Record<string, unknown>) {
  return {
    json: async () => ({ requirements, pdfText: '', pdfImages: [], imageMapping: {} }),
    headers: { get: () => null },
  };
}

/** A model that answers the outline pass with the given scenes, in one chunk. */
function outlineStream(scenes: unknown[]) {
  const body = JSON.stringify({
    languageDirective: '用中文授课，术语保留英文。',
    courseTitle: 'PID 调参',
    outlines: scenes,
  });
  return {
    fullStream: (async function* () {
      yield { type: 'text-delta', text: body };
      yield { type: 'finish', finishReason: 'stop' };
    })(),
  };
}

/** Three scenes where a one-page mode wanted one — the shape ② has to reduce. */
const THREE_SCENES = [
  {
    id: 'scene_intro',
    type: 'slide',
    title: '导入',
    description: '介绍闭环控制。',
    keyPoints: ['认识闭环'],
    order: 1,
  },
  {
    id: 'scene_kp',
    type: 'interactive',
    title: 'Kp 与超调',
    description: '调 Kp 看超调。',
    keyPoints: ['Kp 过大会超调', 'Kp 过小响应慢'],
    order: 2,
    widgetType: 'game',
    widgetOutline: { concept: '比例增益', gameType: 'action', challenge: '压住超调' },
  },
  {
    id: 'scene_ki',
    type: 'interactive',
    title: 'Ki 与稳态误差',
    description: '调 Ki 消稳态误差。',
    keyPoints: ['Ki 消除稳态误差'],
    order: 3,
    widgetType: 'game',
    widgetOutline: { concept: '积分增益', gameType: 'action', challenge: '消除稳态误差' },
  },
];

const CONDENSED = JSON.stringify({
  outline: {
    title: 'PID 调参挑战',
    description: '拖动三个滑杆，把闭环系统调到又快又稳。',
    keyPoints: ['Kp 过大会超调', 'Ki 消除稳态误差'],
    widgetOutline: {
      concept: 'PID 整定',
      gameType: 'action',
      challenge: '把超调压到 5% 以内',
      playerControls: ['slider'],
    },
  },
  dispositions: [
    { index: 1, disposition: 'non-teaching', note: '导入页，无测评点' },
    { index: 2, disposition: 'folded', note: '并入响应曲线挑战' },
    { index: 3, disposition: 'folded', note: '并入稳态误差判定' },
  ],
});

async function run(requirements: Record<string, unknown>) {
  const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
  const response = await POST(mockRequest(requirements) as unknown as Parameters<typeof POST>[0]);
  const events = parseSseEvents(await readStreamBody(response));
  return {
    events,
    done: events.find((event) => event.type === 'done'),
    outlineEvents: events.filter((event) => event.type === 'outline'),
  };
}

describe('single-game outline route', () => {
  beforeEach(() => {
    vi.resetModules();
    streamLLMMock.mockReset();
    callLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'glm.chat', modelId: 'glm-5.1' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'glm:glm-5.1',
      providerId: 'glm',
      modelId: 'glm-5.1',
      serverManaged: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('condenses a three-scene answer into one page instead of dropping two', async () => {
    streamLLMMock.mockReturnValue(outlineStream(THREE_SCENES));
    callLLMMock.mockResolvedValue({ text: CONDENSED });

    const { done, outlineEvents } = await run({
      requirement: '生成 PID 相关内容',
      generationMode: 'single-game',
    });

    expect(callLLMMock).toHaveBeenCalledTimes(1);
    expect(callLLMMock.mock.calls[0][1]).toBe('scene-outlines-condense');
    // Same primary whose fallback the outline call was armed with — otherwise a
    // condensation that fails would be the one call with no net under it.
    expect(callLLMMock.mock.calls[0][4]).toEqual({ serverManaged: true });

    expect(done).toBeDefined();
    expect(done.outlines).toHaveLength(1);
    expect(done.outlines[0]).toMatchObject({
      order: 1,
      type: 'interactive',
      widgetType: 'game',
      title: 'PID 调参挑战',
      // The rubric is the condensed union, not one source scene's.
      keyPoints: ['Kp 过大会超调', 'Ki 消除稳态误差'],
    });
    // 「第 k / N 关」 is printed from these; a single-page product must not
    // carry them.
    expect(done.outlines[0].seriesIndex).toBeUndefined();
    expect(done.outlines[0].seriesTotal).toBeUndefined();
    // The client sees one page, not the three the model produced.
    expect(outlineEvents).toHaveLength(1);
  });

  test('costs no extra model call when the model answers with one scene', async () => {
    streamLLMMock.mockReturnValue(outlineStream([THREE_SCENES[1]]));

    const { done } = await run({
      requirement: '生成 PID 相关内容',
      generationMode: 'single-game',
    });

    expect(callLLMMock).not.toHaveBeenCalled();
    expect(done.outlines).toHaveLength(1);
    expect(done.outlines[0]).toMatchObject({
      type: 'interactive',
      widgetType: 'game',
      title: 'Kp 与超调',
    });
  });

  test('falls back to a page built from every scene when the condenser fails', async () => {
    streamLLMMock.mockReturnValue(outlineStream(THREE_SCENES));
    callLLMMock.mockRejectedValue(new Error('connection reset'));

    const { done } = await run({
      requirement: '生成 PID 相关内容',
      generationMode: 'single-game',
    });

    // One attempt, then the mechanical merge — not a retry loop against a dead
    // connection.
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    expect(done.outlines).toHaveLength(1);
    // Round-robin across the sources, so the page is an excerpt of nothing.
    expect(done.outlines[0].keyPoints).toEqual([
      '认识闭环',
      'Kp 过大会超调',
      'Ki 消除稳态误差',
      'Kp 过小响应慢',
    ]);
  });

  test('retries once on a table that does not account for every scene, then merges', async () => {
    streamLLMMock.mockReturnValue(outlineStream(THREE_SCENES));
    callLLMMock.mockResolvedValue({
      text: JSON.stringify({
        outline: JSON.parse(CONDENSED).outline,
        dispositions: [{ index: 1, disposition: 'folded', note: '并入' }],
      }),
    });

    const { done } = await run({
      requirement: '生成 PID 相关内容',
      generationMode: 'single-game',
    });

    expect(callLLMMock).toHaveBeenCalledTimes(2);
    const retryPrompt = callLLMMock.mock.calls[1][0] as { prompt: string };
    expect(retryPrompt.prompt).toContain('no entry for scene 2, 3');
    expect(done.outlines).toHaveLength(1);
    expect(done.outlines[0].keyPoints).toContain('认识闭环');
  });

  test('leaves material alone when nothing requests a game mode', async () => {
    streamLLMMock.mockReturnValue(outlineStream(THREE_SCENES));

    // The deployment fallback is what a mode-less request resolves to; pin it to
    // classic so this test says what it means.
    vi.stubEnv('OPENMAIC_SINGLE_GAME_MODE', 'false');

    const { done } = await run({ requirement: '生成 PID 相关内容' });

    expect(callLLMMock).not.toHaveBeenCalled();
    expect(done.outlines).toHaveLength(3);
    expect(done.outlines.map((outline: { type: string }) => outline.type)).toEqual([
      'slide',
      'interactive',
      'interactive',
    ]);
  });
});
