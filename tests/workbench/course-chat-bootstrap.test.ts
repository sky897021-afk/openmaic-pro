/**
 * Opening a course must not create a conversation or borrow another course's
 * conversation.
 */
import { describe, expect, it } from 'vitest';

import {
  mostRecentSession,
  resolveCourseChatBootstrap,
} from '@/lib/workbench/course-chat-bootstrap';

const session = (
  id: string,
  updatedAt: number,
  createdAt = updatedAt,
  stageId: string | null = 'course-a',
) => ({
  id,
  stageId,
  updatedAt,
  createdAt,
});

const base = {
  courseId: 'course-a' as string | null,
  sessionId: null as string | null,
  sessions: [] as ReturnType<typeof session>[],
  sessionsLoaded: true,
};

describe('resolveCourseChatBootstrap', () => {
  it('does nothing with no course open', () => {
    expect(resolveCourseChatBootstrap({ ...base, courseId: null })).toEqual({ kind: 'settled' });
  });

  it('leaves an explicitly opened conversation alone, even when it is about another course', () => {
    expect(
      resolveCourseChatBootstrap({
        ...base,
        sessionId: 'session-other',
        sessions: [session('session-course', 5, 5, 'course-a')],
      }),
    ).toEqual({ kind: 'settled' });
  });

  it('treats an attached conversation for this course as already settled', () => {
    expect(
      resolveCourseChatBootstrap({
        ...base,
        attachedSessionId: 'session-attached',
        sessions: [session('session-attached', 1)],
      }),
    ).toEqual({ kind: 'settled' });
  });

  it('adopts the most recent conversation for this course, not the globally most recent one', () => {
    expect(
      resolveCourseChatBootstrap({
        ...base,
        sessions: [
          session('session-course', 1, 1, 'course-a'),
          session('session-other', 9, 9, 'course-b'),
        ],
      }),
    ).toEqual({ kind: 'adopt', sessionId: 'session-course', courseId: 'course-a' });
  });

  it('does not let a known attached conversation from another course block adoption', () => {
    expect(
      resolveCourseChatBootstrap({
        ...base,
        attachedSessionId: 'session-other',
        sessions: [
          session('session-course', 1, 1, 'course-a'),
          session('session-other', 9, 9, 'course-b'),
        ],
      }),
    ).toEqual({ kind: 'adopt', sessionId: 'session-course', courseId: 'course-a' });
  });

  it('shows a draft when no conversation belongs to this course', () => {
    expect(
      resolveCourseChatBootstrap({
        ...base,
        attachedSessionId: 'session-other',
        sessions: [session('session-other', 9, 9, 'course-b')],
      }),
    ).toEqual({ kind: 'draft', courseId: 'course-a' });
  });

  it('keeps a freshly attached session that has not reached the list yet', () => {
    expect(
      resolveCourseChatBootstrap({
        ...base,
        attachedSessionId: 'session-fresh',
        sessions: [],
      }),
    ).toEqual({ kind: 'settled' });
  });

  it('offers an empty conversation and no mint when the user has none at all', () => {
    expect(resolveCourseChatBootstrap(base)).toEqual({ kind: 'draft', courseId: 'course-a' });
  });

  it('waits for the session list before deciding either branch', () => {
    expect(resolveCourseChatBootstrap({ ...base, sessionsLoaded: false })).toEqual({
      kind: 'settled',
    });
  });

  it('is stable across repeated visits to the same course', () => {
    const input = { ...base, sessions: [session('session-course', 9)] };
    expect(resolveCourseChatBootstrap(input)).toEqual(resolveCourseChatBootstrap(input));
    expect(resolveCourseChatBootstrap({ ...input, sessionId: 'session-course' })).toEqual({
      kind: 'settled',
    });
  });
});

describe('mostRecentSession', () => {
  it('prefers the most recently active over the most recently created', () => {
    expect(mostRecentSession([session('a', 10, 1), session('b', 2, 9)])?.id).toBe('a');
  });

  it('falls back to createdAt for a session never updated', () => {
    expect(mostRecentSession([session('a', 0, 5), session('b', 0, 3)])?.id).toBe('a');
  });

  it('breaks ties deterministically instead of depending on list order', () => {
    expect(mostRecentSession([session('a', 5), session('b', 5)])?.id).toBe('b');
    expect(mostRecentSession([session('b', 5), session('a', 5)])?.id).toBe('b');
  });

  it('has nothing to offer for an empty list', () => {
    expect(mostRecentSession([])).toBeNull();
  });
});
