/**
 * Integration contract: what the platform may send.
 *
 * The important guarantees pinned here:
 *  - unknown outline fields survive the edit round-trip (`quizConfig` etc.);
 *  - order is honoured and renumbered, so drag-and-drop needs no renumbering;
 *  - a classic course rejects a `pbl` page rather than silently building one;
 *  - material text is composed with headers, and empty media contributes none.
 */
import { describe, expect, it } from 'vitest';

import {
  composeMaterialsText,
  normalizeOutlines,
  parseCourseRequest,
  parseOutlineRequest,
} from '@/lib/server/integration/contract';

const page = (overrides: Record<string, unknown> = {}) => ({
  id: 'scene_1',
  order: 1,
  type: 'slide',
  title: '裂解工段总览',
  description: '介绍裂解工段的整体流程',
  keyPoints: ['原料', '裂解炉'],
  ...overrides,
});

describe('normalizeOutlines', () => {
  it('keeps unknown fields so an edited quiz page does not lose its config', () => {
    const result = normalizeOutlines([
      page({
        type: 'quiz',
        quizConfig: { questionCount: 3, difficulty: 'easy', questionTypes: ['single'] },
      }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].quizConfig).toEqual({
      questionCount: 3,
      difficulty: 'easy',
      questionTypes: ['single'],
    });
  });

  it('sorts by order and renumbers from 1', () => {
    const result = normalizeOutlines([
      page({ id: 'c', order: 30, title: 'Third' }),
      page({ id: 'a', order: 10, title: 'First' }),
      page({ id: 'b', order: 20, title: 'Second' }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => [entry.title, entry.order])).toEqual([
      ['First', 1],
      ['Second', 2],
      ['Third', 3],
    ]);
  });

  it('regenerates a duplicate id instead of rejecting the plan', () => {
    const result = normalizeOutlines([page(), page({ order: 2 })]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.value.map((entry) => entry.id)).size).toBe(2);
  });

  it('keeps every id unique when requested ids collide with generated fallbacks', () => {
    const result = normalizeOutlines([
      page({ id: 'outline_2', order: 1 }),
      page({ id: 'outline_2', order: 2 }),
      page({ id: 'outline_2_2', order: 3 }),
      page({ id: 'outline_3', order: 4 }),
      page({ id: '', order: 5 }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects a PBL page, which a classic course cannot build', () => {
    const result = normalizeOutlines([page({ type: 'pbl' })]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('slide, quiz, interactive');
  });

  it('names the offending page for a missing description', () => {
    const result = normalizeOutlines([page(), page({ order: 2, description: '  ' })]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('outlines[1].description');
  });

  it('rejects an empty plan', () => {
    expect(normalizeOutlines([]).ok).toBe(false);
    expect(normalizeOutlines(undefined).ok).toBe(false);
  });
});

describe('composeMaterialsText', () => {
  it('labels each resource and skips empty media', () => {
    const text = composeMaterialsText([
      { title: '操作手册', kind: 'docx', text: '第一章……' },
      { title: '装置视频', kind: 'video', text: '' },
      { text: '无标题的补充材料' },
    ]);

    expect(text).toContain('### 操作手册 (docx)\n第一章……');
    expect(text).toContain('### Material 3\n无标题的补充材料');
    expect(text).not.toContain('装置视频');
  });
});

describe('parseOutlineRequest / parseCourseRequest', () => {
  it('requires a tenant and a requirement', () => {
    expect(parseOutlineRequest({ requirement: 'x' }).ok).toBe(false);
    expect(parseOutlineRequest({ tenantId: 't' }).ok).toBe(false);
  });

  it('carries material text into pdfContent input and keeps options', () => {
    const result = parseOutlineRequest({
      tenantId: 'dfsm',
      requirement: '生成一节完整课程',
      materials: [{ title: '手册', kind: 'docx', text: '正文' }],
      options: { enableImageGeneration: true, enableWebSearch: 'yes' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.materialsText).toContain('正文');
    expect(result.value.options).toEqual({ enableImageGeneration: true });
  });

  it('requires an approved outline on the course request', () => {
    const result = parseCourseRequest({
      tenantId: 'dfsm',
      requirement: '生成一节完整课程',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('outlines');
  });

  it('accepts a complete course request', () => {
    const result = parseCourseRequest({
      tenantId: 'dfsm',
      requirement: '生成一节完整课程',
      outlines: [page()],
      courseTitle: '乙烯裂解流程认知',
      languageDirective: 'zh',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outlines).toHaveLength(1);
    expect(result.value.courseTitle).toBe('乙烯裂解流程认知');
  });
});
