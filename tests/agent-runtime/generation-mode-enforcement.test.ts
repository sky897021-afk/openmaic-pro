/**
 * The workbench's half of the mode contract.
 *
 * On the classic path a mode is enforced AFTER planning: the model writes an
 * outline and code coerces it (`coerceToSingleGameOutline` /
 * `coerceToGameOutlines`). The workbench has no outline stage — the agent plans
 * in conversation and calls `generate_scene` — so these are the tests that pin
 * down where the promise is kept instead: at page creation, inside the tool.
 */
import { describe, expect, it, vi } from 'vitest';
import { Value } from 'typebox/value';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import type { CourseDocument, CourseStore } from '@/lib/server/agent-runtime/course-tools';
import { buildGenerationTools } from '@/lib/server/agent-runtime/generation-tools';

const GAME_HTML = '<!DOCTYPE html><html><body><div id="widget"></div></body></html>';

function emptyDocument(): CourseDocument {
  return {
    stage: { id: 'stage-test', name: 'Test', createdAt: 1, updatedAt: 1 },
    scenes: [],
    outline: { outlines: [], createdAt: 1, updatedAt: 1 },
  } as CourseDocument;
}

function state(initial: CourseDocument | null) {
  let doc = initial ? structuredClone(initial) : null;
  const store = {
    loadDocument: vi.fn(async () => doc),
    putScene: vi.fn(async (_stageId: string, scene: Record<string, unknown>) => {
      if (!doc) throw new Error('missing');
      const scenes = doc.scenes as unknown as Record<string, unknown>[];
      const index = scenes.findIndex((item) => item.id === scene.id);
      doc.scenes =
        index < 0
          ? ([...scenes, scene] as unknown as CourseDocument['scenes'])
          : (scenes.map((item) => (item.id === scene.id ? scene : item)) as unknown as
              CourseDocument['scenes']);
    }),
    saveDocument: vi.fn(async (next: CourseDocument) => {
      doc = structuredClone(next);
    }),
  } as unknown as CourseStore;
  return { store, get: () => doc };
}

function find(tools: AgentTool<never, never>[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

/** A toolset whose content model records every system prompt it is handed. */
function gameTools(
  store: CourseStore,
  generationMode?: 'classic' | 'single-game' | 'multi-game',
  response: string = GAME_HTML,
) {
  const systemPrompts: string[] = [];
  const aiCall = vi.fn(async (system: string) => {
    systemPrompts.push(system);
    return response;
  });
  const generateActions = vi.fn(async () => []);
  const tools = buildGenerationTools({
    store,
    stageAccess: async () => ({ kind: 'owned' as const }),
    sessionId: 'session-a',
    onCheckpoint: vi.fn(),
    ...(generationMode ? { generationMode } : {}),
    aiCall,
    generateActions,
  } as never);
  return { generate: find(tools, 'generate_scene'), systemPrompts, aiCall };
}

const PAGE = (over: Record<string, unknown>) => ({
  stageId: 'stage-test',
  order: 1,
  title: 'Gravity',
  type: 'slide',
  brief: 'Play with gravity',
  ...over,
});

describe('② single-game enforcement', () => {
  it('refuses every page but the first, before doing any work', async () => {
    const current = state(emptyDocument());
    const { generate, aiCall } = gameTools(current.store, 'single-game');

    const response = (await generate.execute('call', PAGE({ order: 2 }))) as {
      isError?: boolean;
      details: Record<string, unknown>;
    };

    expect(response.isError).toBe(true);
    expect(response.details.blocked).toBe('single-game-page-cap');
    expect(current.get()?.scenes).toEqual([]);
    // The cap is cheap by construction: refusing must not cost a generation.
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('coerces a requested slide into one whole-lesson interactive game', async () => {
    const current = state(emptyDocument());
    const { generate, systemPrompts } = gameTools(current.store, 'single-game');

    const response = (await generate.execute('call', PAGE({}))) as { isError?: boolean };

    expect(response.isError).not.toBe(true);
    expect(current.get()?.scenes[0]).toMatchObject({
      type: 'interactive',
      content: { type: 'interactive', widgetType: 'game' },
    });
    // The widget is built under the whole-lesson contract, not the level one:
    // the template picks its shape off exactly this pair, and a single game
    // page that renders as "level 1 / 1" contradicts what ② promises.
    expect(systemPrompts[0]).toContain('entire lesson');
    expect(systemPrompts[0]).not.toContain('level 1 of 1');
  });
});

describe('③ multi-game enforcement', () => {
  it('requires the series total on the first page', async () => {
    const current = state(emptyDocument());
    const { generate } = gameTools(current.store, 'multi-game');

    const response = (await generate.execute('call', PAGE({ seriesIndex: 1 }))) as {
      isError?: boolean;
      details: Record<string, unknown>;
    };

    expect(response.isError).toBe(true);
    expect(response.details.error).toBe('series-total-required');
    expect(current.get()?.scenes).toEqual([]);
  });

  it('requires the level index on every page', async () => {
    const current = state(emptyDocument());
    const { generate } = gameTools(current.store, 'multi-game');

    const response = (await generate.execute('call', PAGE({ seriesTotal: 3 }))) as {
      isError?: boolean;
      details: Record<string, unknown>;
    };

    expect(response.isError).toBe(true);
    expect(response.details.error).toBe('series-index-required');
  });

  it('keeps a game page per objective and prints the same total on each', async () => {
    const current = state(emptyDocument());
    const { generate, systemPrompts } = gameTools(current.store, 'multi-game');

    for (const [index, title] of ['Light', 'Dark'].entries()) {
      const response = (await generate.execute(`call-${index}`, {
        ...PAGE({ order: index + 1, title }),
        seriesIndex: index + 1,
        seriesTotal: 3,
      })) as { isError?: boolean };
      expect(response.isError).not.toBe(true);
    }

    const scenes = current.get()?.scenes ?? [];
    // No page cap in ③: more objectives really do mean more pages.
    expect(scenes.map((scene) => scene.title)).toEqual(['Light', 'Dark']);
    expect(scenes.every((scene) => scene.type === 'interactive')).toBe(true);
    expect(systemPrompts[0]).toContain('level 1 of 3');
    expect(systemPrompts[1]).toContain('level 2 of 3');
  });

  it('locks the total after the first page, because the pages already say it', async () => {
    const current = state(emptyDocument());
    const { generate } = gameTools(current.store, 'multi-game');

    await generate.execute('first', {
      ...PAGE({}),
      seriesIndex: 1,
      seriesTotal: 3,
    });

    const response = (await generate.execute('second', {
      ...PAGE({ order: 2, title: 'Dark' }),
      seriesIndex: 2,
      seriesTotal: 5,
    })) as { isError?: boolean; details: Record<string, unknown> };

    expect(response.isError).toBe(true);
    expect(response.details).toMatchObject({ blocked: 'series-total-locked', seriesTotal: 3 });
    expect(current.get()?.scenes).toHaveLength(1);
  });

  it('refuses a level index past the frozen total', async () => {
    const current = state(emptyDocument());
    const { generate } = gameTools(current.store, 'multi-game');

    await generate.execute('first', { ...PAGE({}), seriesIndex: 1, seriesTotal: 2 });

    const response = (await generate.execute('second', {
      ...PAGE({ order: 2, title: 'Dark' }),
      seriesIndex: 3,
      seriesTotal: 2,
    })) as { isError?: boolean; details: Record<string, unknown> };

    expect(response.isError).toBe(true);
    expect(response.details.blocked).toBe('series-index-out-of-range');
  });
});

describe('① classic is untouched', () => {
  const QUIZ_JSON = JSON.stringify([{ id: 'q1', type: 'short_answer', question: 'Why?' }]);

  it('writes the requested page type and adds no mode wording', async () => {
    const current = state(emptyDocument());
    const { generate, systemPrompts } = gameTools(current.store, 'classic', QUIZ_JSON);

    const response = (await generate.execute('call', PAGE({ type: 'quiz' }))) as {
      isError?: boolean;
    };

    expect(response.isError).not.toBe(true);
    expect(current.get()?.scenes[0]).toMatchObject({ type: 'quiz' });
    expect(systemPrompts[0]).not.toContain('entire lesson');
    expect(systemPrompts[0]).not.toContain('level 1 of');
  });

  it('ignores the series pair, since classic has no series to place a page in', async () => {
    const current = state(emptyDocument());
    const { generate } = gameTools(current.store, undefined, QUIZ_JSON);

    const response = (await generate.execute('call', {
      ...PAGE({ type: 'quiz' }),
      seriesIndex: 1,
      seriesTotal: 3,
    })) as { isError?: boolean };

    expect(response.isError).not.toBe(true);
    expect(current.get()?.scenes[0]).toMatchObject({ type: 'quiz' });
  });
});

describe('generate_scene schema', () => {
  it('accepts a well-formed series pair and rejects a degenerate one', () => {
    const current = state(emptyDocument());
    const { generate } = gameTools(current.store, 'multi-game');
    const base = PAGE({});

    expect(Value.Check(generate.parameters, { ...base, seriesIndex: 2, seriesTotal: 3 })).toBe(true);
    // A "series" of one is the single-game shape, declared in the wrong mode.
    expect(Value.Check(generate.parameters, { ...base, seriesIndex: 1, seriesTotal: 1 })).toBe(false);
    expect(Value.Check(generate.parameters, { ...base, seriesIndex: 0, seriesTotal: 3 })).toBe(false);
  });
});