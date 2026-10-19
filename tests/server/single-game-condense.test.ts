/**
 * ②'s condenser.
 *
 * The prompt asks for one scene; a long document still invites a course-shaped
 * answer, and the finaliser used to keep one scene and drop the rest. What is
 * pinned here is the property that replaced it: **every input scene is
 * accounted for**, and the ways a model can fail to do that are each named
 * precisely enough to be corrected on the retry.
 */
import { describe, expect, it } from 'vitest';

import {
  DISPOSITIONS,
  checkDispositions,
  condenseOutlines,
  mergeOutlinesMechanically,
  readCondensedScene,
  summarizeDispositions,
} from '@/lib/server/single-game-condense';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';

const requirements: UserRequirements = { requirement: '生成 PID 相关内容' };

function scene(overrides: Partial<SceneOutline> & { order: number }): SceneOutline {
  return {
    id: `scene-${overrides.order}`,
    type: 'slide',
    title: `Scene ${overrides.order}`,
    description: `Description ${overrides.order}`,
    keyPoints: [`point ${overrides.order}`],
    ...overrides,
  };
}

const threeScenes = [
  scene({ order: 1, title: '导入', keyPoints: ['认识 PID'] }),
  scene({
    order: 2,
    title: 'Kp 与超调',
    keyPoints: ['Kp 过大会超调', 'Kp 过小响应慢'],
  }),
  scene({ order: 3, title: 'Ki 与稳态误差', keyPoints: ['Ki 消除稳态误差'] }),
];

const table = [
  { index: 1, disposition: 'non-teaching', note: '导入页，无测评点' },
  { index: 2, disposition: 'folded', note: '并入响应曲线挑战' },
  { index: 3, disposition: 'folded', note: '并入稳态误差判定' },
];

describe('checkDispositions', () => {
  it('accepts a table that accounts for every scene exactly once', () => {
    const check = checkDispositions(table, 3);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.entries.map((entry) => entry.index)).toEqual([1, 2, 3]);
      expect(check.entries.map((entry) => entry.disposition)).toEqual([
        'non-teaching',
        'folded',
        'folded',
      ]);
    }
  });

  it('does NOT require every scene to be folded', () => {
    // A course-shaped list really does contain an agenda and a summary; forcing
    // those into the one game would be padding. The guarantee is coverage of
    // the table, not fidelity to the model's page count.
    const check = checkDispositions(
      [
        { index: 1, disposition: 'non-teaching', note: '目录页' },
        { index: 2, disposition: 'redundant', note: '与场景 2 重复' },
        { index: 3, disposition: 'redundant', note: '与场景 2 重复' },
      ],
      3,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(' ')).toContain('no scene as `folded`');
  });

  it('names the scene a table forgot', () => {
    const check = checkDispositions([table[0], table[1]], 3);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      const problems = check.problems.join(' ');
      // Both the length and — more usefully to a retrying model — the index.
      expect(problems).toContain('exactly 3 entries');
      expect(problems).toContain('no entry for scene 3');
    }
  });

  it('rejects a repeated index', () => {
    const check = checkDispositions([table[0], table[0], table[2]], 3);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(' ')).toContain('repeats index 1');
  });

  it('rejects an index outside 1..sceneCount', () => {
    const check = checkDispositions(
      [table[0], table[1], { index: 9, disposition: 'folded', note: 'x' }],
      3,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(' ')).toContain('outside 1..3');
  });

  it('rejects an unknown disposition and lists the legal ones', () => {
    const check = checkDispositions(
      [table[0], table[1], { index: 3, disposition: 'merged', note: 'x' }],
      3,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) {
      const problems = check.problems.join(' ');
      expect(problems).toContain('unknown disposition');
      for (const disposition of DISPOSITIONS) expect(problems).toContain(disposition);
    }
  });

  it('requires a note on every entry', () => {
    for (const note of [undefined, '', '   ']) {
      const check = checkDispositions(
        [table[0], table[1], { index: 3, disposition: 'folded', note }],
        3,
      );
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.problems.join(' ')).toContain('no `note` for scene 3');
    }
  });

  it('rejects anything that is not an array', () => {
    for (const value of [undefined, null, {}, 'folded']) {
      const check = checkDispositions(value, 3);
      expect(check.ok).toBe(false);
    }
  });
});

describe('extractCondensedScene', () => {
  const raw = {
    order: 7,
    seriesIndex: 3,
    seriesTotal: 12,
    type: 'slide',
    title: 'PID 调参挑战',
    description: '拖动三个滑杆，把闭环系统调到又快又稳。',
    keyPoints: ['Kp 过大会超调', 'Ki 消除稳态误差'],
    widgetOutline: { concept: 'PID 整定', gameType: 'action', challenge: '把超调压到 5% 以内' },
  };

  it('builds the one game scene, ignoring the model order/series fields', () => {
    const read = readCondensedScene(raw);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.scene).toMatchObject({
      id: 'game-1',
      order: 1,
      type: 'interactive',
      widgetType: 'game',
      title: 'PID 调参挑战',
    });
    // ② is one whole-lesson game. A surviving `seriesTotal` makes the
    // game-content template render 「第 k / N 关」 on a single-page product.
    expect(read.scene).not.toHaveProperty('seriesIndex');
    expect(read.scene).not.toHaveProperty('seriesTotal');
  });

  it('drops a gameType outside the widget contract, keeping the rest', () => {
    const read = readCondensedScene({
      ...raw,
      widgetOutline: { concept: 'PID 整定', gameType: 'rhythm' },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.scene.widgetOutline?.gameType).toBeUndefined();
    expect(read.scene.widgetOutline?.concept).toBe('PID 整定');
  });

  it('names the field it rejected, so the retry can fix that one thing', () => {
    const problem = (value: unknown) => {
      const read = readCondensedScene(value);
      return read.ok ? null : read.problem;
    };
    expect(problem({ ...raw, title: '  ' })).toContain('title');
    expect(problem({ ...raw, description: '' })).toContain('description');
    expect(problem({ ...raw, keyPoints: [] })).toContain('keyPoints');
    expect(problem({ ...raw, keyPoints: ['', '  '] })).toContain('keyPoints');
    expect(problem(null)).toContain('not an object');
    expect(problem(['x'])).toContain('not an object');
    expect(problem(raw)).toBeNull();
  });
});

describe('mergeOutlinesMechanically', () => {
  it('hears every scene before it hears any scene twice', () => {
    const merged = mergeOutlinesMechanically(
      [
        scene({ order: 1, keyPoints: ['a1', 'a2', 'a3', 'a4'] }),
        scene({ order: 2, keyPoints: ['b1', 'b2'] }),
        scene({ order: 3, keyPoints: ['c1'] }),
      ],
      requirements,
    );
    expect(merged.outline.keyPoints).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'a4']);
    expect(merged.coveredScenes).toBe(3);
    expect(merged.droppedKeyPoints).toBe(0);
  });

  it('deduplicates repeated points and counts what it could not carry', () => {
    const merged = mergeOutlinesMechanically(
      [
        scene({ order: 1, keyPoints: ['同一句', 'a'] }),
        scene({ order: 2, keyPoints: ['同一句', '同一句'] }),
      ],
      requirements,
    );
    expect(merged.outline.keyPoints).toEqual(['同一句', 'a']);
    expect(merged.droppedKeyPoints).toBe(2);
  });

  it('caps the merged rubric so the page stays one game', () => {
    const long = Array.from({ length: 40 }, (_, i) => scene({ order: i + 1 }));
    const merged = mergeOutlinesMechanically(long, requirements);
    expect(merged.outline.keyPoints.length).toBe(12);
    expect(merged.droppedKeyPoints).toBe(28);
  });

  it('still produces a page when no scene carried a key point', () => {
    const merged = mergeOutlinesMechanically(
      [scene({ order: 1, keyPoints: [] }), scene({ order: 2, keyPoints: [] })],
      requirements,
    );
    expect(merged.outline.keyPoints).toEqual([requirements.requirement]);
    expect(merged.coveredScenes).toBe(0);
  });

  it('leaves the description to the caller, which fills it from the requirement', () => {
    // Code cannot write a description of a game nobody designed. An empty one
    // makes `toGameScene` fall back to the requirement, which is the only
    // description of the merged page that is not a lie about one source scene.
    const merged = mergeOutlinesMechanically(threeScenes, requirements);
    expect(merged.outline.description).toBe('');
    expect(merged.outline.title).toBe('导入');
    expect(merged.outline.type).toBe('interactive');
    expect(merged.outline.widgetType).toBe('game');
  });
});

describe('summarizeDispositions', () => {
  it('counts only the dispositions that occurred, in table order', () => {
    expect(
      summarizeDispositions([
        { index: 1, disposition: 'non-teaching', note: 'x' },
        { index: 2, disposition: 'folded', note: 'x' },
        { index: 3, disposition: 'folded', note: 'x' },
      ]),
    ).toBe('folded 2, non-teaching 1');
  });
});

describe('condenseOutlines', () => {
  const okResponse = JSON.stringify({
    outline: {
      title: 'PID 调参挑战',
      description: '拖动滑杆把闭环调到又快又稳。',
      keyPoints: ['Kp 过大会超调'],
      widgetOutline: { concept: 'PID 整定', gameType: 'action', challenge: '压缩超调' },
    },
    dispositions: table,
  });

  it('condenses the surplus in one call and reports the dispositions', async () => {
    const prompts: Array<{ system: string; user: string }> = [];
    const outcome = await condenseOutlines({
      outlines: threeScenes,
      requirements,
      languageDirective: '用中文授课',
      runModel: async (prompt) => {
        prompts.push(prompt);
        return okResponse;
      },
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempts).toBe(1);
      expect(outcome.scene.keyPoints).toEqual(['Kp 过大会超调']);
      expect(outcome.dispositions).toHaveLength(3);
    }
    expect(prompts).toHaveLength(1);
    // The condenser has to see every scene, and it is told how many it owes an
    // answer for.
    expect(prompts[0].user).toContain('"index": 3');
    expect(prompts[0].user).toContain('Kp 过大会超调');
    expect(prompts[0].user).toContain('Ki 消除稳态误差');
    expect(prompts[0].user).toContain('生成 PID 相关内容');
    expect(prompts[0].user).not.toContain('Correction required');
    // A placeholder that survives interpolation is invisible to the model and
    // silently drops the contract it was meant to carry.
    expect(prompts[0].system).not.toMatch(/\{\{\w[\w-]*\}\}/);
    expect(prompts[0].user).not.toMatch(/\{\{\w[\w-]*\}\}/);
    expect(prompts[0].system).toContain('dispositions');
  });

  it('retries once, naming the scene that went missing', async () => {
    const userPrompts: string[] = [];
    const outcome = await condenseOutlines({
      outlines: threeScenes,
      requirements,
      languageDirective: '用中文授课',
      runModel: async (prompt) => {
        userPrompts.push(prompt.user);
        if (userPrompts.length === 1) {
          return JSON.stringify({
            outline: JSON.parse(okResponse).outline,
            dispositions: [table[0], table[1]],
          });
        }
        return okResponse;
      },
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
    expect(userPrompts).toHaveLength(2);
    // "点名重试": the correction has to name the gap, not just complain.
    expect(userPrompts[1]).toContain('Correction required');
    expect(userPrompts[1]).toContain('no entry for scene 3');
  });

  it('reads the object out of a fenced block rather than burning the retry on formatting', async () => {
    const outcome = await condenseOutlines({
      outlines: threeScenes,
      requirements,
      languageDirective: '用中文授课',
      runModel: async () => 'Here you go:\n\n```json\n' + okResponse + '\n```\n',
    });
    expect(outcome.ok).toBe(true);
  });

  it('names the missing outline field in the correction too', async () => {
    const userPrompts: string[] = [];
    const outline = { ...JSON.parse(okResponse).outline };
    delete outline.description;
    const outcome = await condenseOutlines({
      outlines: threeScenes,
      requirements,
      languageDirective: '用中文授课',
      runModel: async (prompt) => {
        userPrompts.push(prompt.user);
        return userPrompts.length === 1
          ? JSON.stringify({ outline, dispositions: table })
          : okResponse;
      },
    });

    expect(outcome.ok).toBe(true);
    expect(userPrompts[1]).toContain('`outline.description` is missing');
  });

  it('gives up after the retry when the table never covers every scene', async () => {
    let calls = 0;
    const outcome = await condenseOutlines({
      outlines: threeScenes,
      requirements,
      languageDirective: '用中文授课',
      runModel: async () => {
        calls++;
        return JSON.stringify({
          outline: JSON.parse(okResponse).outline,
          dispositions: [table[0], table[1]],
        });
      },
    });

    expect(calls).toBe(2);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('invalid-output');
      expect(outcome.attempts).toBe(2);
      expect(outcome.detail).toContain('no entry for scene 3');
    }
  });

  it('reports a transport failure instead of throwing', async () => {
    const outcome = await condenseOutlines({
      outlines: threeScenes,
      requirements,
      languageDirective: '用中文授课',
      runModel: async () => {
        throw new Error('connection reset');
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('model-error');
      expect(outcome.detail).toBe('connection reset');
      expect(outcome.attempts).toBe(1);
    }
  });

  it('reports unparsable output rather than throwing', async () => {
    const outcome = await condenseOutlines({
      outlines: threeScenes,
      requirements,
      languageDirective: '用中文授课',
      runModel: async () => 'I could not do that.',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('invalid-output');
  });
});
