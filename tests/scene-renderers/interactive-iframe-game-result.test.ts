// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InteractiveIframeHost,
  handleGameResultMessage,
  type GameResultSeen,
} from '@/components/scene-renderers/InteractiveIframeHost';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';
import { useStageStore } from '@/lib/store/stage';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import { GAME_RESULT_MESSAGE_TYPE, normalizeGameResultPayload } from '@/lib/game/runtime/types';

const { recordGameResult } = vi.hoisted(() => ({ recordGameResult: vi.fn() }));
vi.mock('@/lib/game/runtime/record', () => ({ recordGameResult }));

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const SCENE_ID = 'scene-game';

/** Exactly what a generated game page posts from its `endSession()`. */
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

function expectedPayload() {
  const payload = normalizeGameResultPayload(WIRE_RESULT);
  if (!payload) throw new Error('fixture must normalize');
  return payload;
}

function gameMessage(payload: unknown = WIRE_RESULT) {
  return { type: GAME_RESULT_MESSAGE_TYPE, payload };
}

function freshSeen(): GameResultSeen {
  return { current: null };
}

function seedPool() {
  useInteractiveIframePool.setState({
    entries: {
      [SCENE_ID]: {
        srcDoc: '<div>Game</div>',
        rect: { left: 0, top: 0, width: 960, height: 540 },
        clip: { left: 0, top: 0, width: 960, height: 540 },
        owner: 'test-owner',
        tick: 1,
      },
    },
    activeSceneId: SCENE_ID,
    tick: 1,
    reset: vi.fn(),
  });
}

/** jsdom's MessageEvent init ignores nothing, but `source` is safest set directly. */
function dispatchFrom(source: Window | null, data: unknown) {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: source, configurable: true });
  window.dispatchEvent(event);
}

const resetInteractiveIframePool = useInteractiveIframePool.getState().reset;

beforeEach(() => {
  recordGameResult.mockReset();
  recordGameResult.mockResolvedValue(undefined);
});

afterEach(() => {
  useInteractiveIframePool.setState({ reset: resetInteractiveIframePool });
  resetInteractiveIframePool();
  useSceneRuntimeErrors.setState({ errors: {} });
  useStageStore.setState({ stage: null });
  useWidgetIframeStore.setState({
    sendMessageByScene: {},
    documentTokenByScene: {},
    readyByScene: {},
    pendingMessagesByScene: {},
    activeSceneId: null,
  });
});

describe('handleGameResultMessage', () => {
  it('claims only game-result messages and leaves every other message to the picker branches', () => {
    const seen = freshSeen();
    const record = vi.fn().mockResolvedValue(undefined);
    const claim = (data: unknown) =>
      handleGameResultMessage(SCENE_ID, 'stage-1', true, data as never, seen, record, () => 0);

    expect(claim({ __maicInteractive: true, kind: 'element-picked', mode: 'editor' })).toBe(false);
    expect(claim({ __maicInteractive: true, kind: 'runtime-error', errorKind: 'TypeError' })).toBe(
      false,
    );
    expect(claim(undefined)).toBe(false);
    expect(claim({ type: 'maic:game-result:v2', payload: WIRE_RESULT })).toBe(false);
    expect(record).not.toHaveBeenCalled();

    expect(claim(gameMessage())).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('files a finished play under the stage, scene, and normalized payload', () => {
    const record = vi.fn().mockResolvedValue(undefined);
    expect(
      handleGameResultMessage(
        SCENE_ID,
        'stage-1',
        true,
        gameMessage(),
        freshSeen(),
        record,
        () => 1_000,
      ),
    ).toBe(true);
    expect(record).toHaveBeenCalledExactlyOnceWith({
      stageId: 'stage-1',
      sceneId: SCENE_ID,
      payload: expectedPayload(),
    });
  });

  it('drops a byte-identical repeat inside the duplicate window but keeps a later replay', () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const seen = freshSeen();
    const claim = (at: number, payload: unknown = WIRE_RESULT) =>
      handleGameResultMessage(
        SCENE_ID,
        'stage-1',
        true,
        gameMessage(payload),
        seen,
        record,
        () => at,
      );

    claim(0);
    claim(1_400); // endSession() ran twice: timeout and click agree
    expect(record).toHaveBeenCalledTimes(1);

    claim(1_400 + 1_501);
    expect(record).toHaveBeenCalledTimes(2);

    // A genuine replay of the same scene scores differently, so the guard must
    // let it through even inside the window.
    claim(1_400 + 1_502, { ...WIRE_RESULT, score: 55 });
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('swallows the message without writing when the record would be unaddressable', () => {
    const record = vi.fn().mockResolvedValue(undefined);
    expect(
      handleGameResultMessage(SCENE_ID, undefined, true, gameMessage(), freshSeen(), record),
    ).toBe(true);
    expect(
      handleGameResultMessage(SCENE_ID, 'stage-1', false, gameMessage(), freshSeen(), record),
    ).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });

  it('skips a model-authored payload that cannot be trusted', () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const seen = freshSeen();
    const claim = (payload: unknown) =>
      handleGameResultMessage(
        SCENE_ID,
        'stage-1',
        true,
        gameMessage(payload),
        seen,
        record,
        () => 0,
      );

    expect(claim({ grade: '优秀' })).toBe(true); // no score at all
    expect(claim({ ...WIRE_RESULT, score: '87' })).toBe(true); // score as a string
    expect(claim(null)).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });

  it('never lets a storage failure escape the message listener', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const record = vi.fn().mockRejectedValue(new Error('storage offline'));
    expect(
      handleGameResultMessage(SCENE_ID, 'stage-1', true, gameMessage(), freshSeen(), record),
    ).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('InteractiveIframeHost game results', () => {
  const render = async () => {
    seedPool();
    useStageStore.setState({ stage: { id: 'stage-1' } as never });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(InteractiveIframeHost));
      await Promise.resolve();
    });
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[title="Interactive Scene ' + SCENE_ID + '"]',
    );
    if (!iframe?.contentWindow) throw new Error('iframe did not mount');
    return { root, container, contentWindow: iframe.contentWindow };
  };

  it('persists a result posted by its own iframe', async () => {
    const { root, container, contentWindow } = await render();

    await act(async () => {
      dispatchFrom(contentWindow, gameMessage());
      await Promise.resolve();
    });

    expect(recordGameResult).toHaveBeenCalledExactlyOnceWith({
      stageId: 'stage-1',
      sceneId: SCENE_ID,
      payload: expectedPayload(),
    });

    act(() => root.unmount());
    container.remove();
  });

  it('ignores a result posted by some other frame', async () => {
    const { root, container } = await render();

    await act(async () => {
      dispatchFrom(null, gameMessage());
      dispatchFrom(window, gameMessage());
      await Promise.resolve();
    });

    expect(recordGameResult).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it('leaves the runtime-error banner branch working', async () => {
    const { root, container, contentWindow } = await render();

    await act(async () => {
      dispatchFrom(contentWindow, {
        __maicInteractive: true,
        kind: 'runtime-error',
        errorKind: 'TypeError',
        message: 'boom',
      });
      await Promise.resolve();
    });

    expect(useSceneRuntimeErrors.getState().errors[SCENE_ID]).toEqual(['[TypeError] boom']);
    expect(recordGameResult).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });
});
