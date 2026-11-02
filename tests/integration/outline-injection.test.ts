/**
 * The decision point for module 1: an approved outline must be used as-is.
 *
 * This is the one line that makes the platform's review step meaningful — if
 * the pipeline always regenerated its own outline, the teacher's edits would be
 * silently discarded.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LANGUAGE_DIRECTIVE } from '@openmaic/generation';

import { resolveClassroomOutlinePlan } from '@/lib/server/classroom-generation';
import type { SceneOutline } from '@/lib/types/generation';

const approved: SceneOutline = {
  id: 'scene_1',
  order: 1,
  type: 'slide',
  title: '裂解工段总览',
  description: '介绍裂解工段的整体流程',
  keyPoints: ['原料', '裂解炉'],
};

describe('resolveClassroomOutlinePlan', () => {
  it('uses the approved outline and never calls the generator', async () => {
    const generate = vi.fn();

    const plan = await resolveClassroomOutlinePlan(
      {
        requirement: '生成一节完整课程',
        outlines: [approved],
        courseTitle: '  乙烯裂解流程认知  ',
        languageDirective: '  zh  ',
      },
      generate,
    );

    expect(generate).not.toHaveBeenCalled();
    expect(plan).toEqual({
      courseTitle: '乙烯裂解流程认知',
      languageDirective: 'zh',
      outlines: [approved],
    });
  });

  it('falls back to the package language directive when none was supplied', async () => {
    const plan = await resolveClassroomOutlinePlan(
      { requirement: '生成一节完整课程', outlines: [approved] },
      vi.fn(),
    );

    expect(plan.languageDirective).toBe(DEFAULT_LANGUAGE_DIRECTIVE);
    expect(plan.courseTitle).toBeUndefined();
  });

  it('generates a fresh outline when no approved plan is supplied', async () => {
    const generated = {
      languageDirective: 'zh',
      outlines: [approved],
    };
    const generate = vi.fn().mockResolvedValue(generated);

    const plan = await resolveClassroomOutlinePlan({ requirement: '生成一节完整课程' }, generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(plan).toBe(generated);
  });
});
