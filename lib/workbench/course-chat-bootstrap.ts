/**
 * A course opened on its own gets its own conversation beside it - but never a
 * NEW one.
 *
 * `/workspace?course=<id>` used to adopt whichever conversation was most
 * recently active, even when that conversation belonged to another course.
 * Reopening an old course then replayed an unrelated run beside it, which
 * looked like the saved course had started regenerating.
 *
 * The rules are:
 *
 * 1. An explicitly selected `?session=` is never replaced.
 * 2. A new-chat request shows a draft and creates nothing until the first
 *    message.
 * 3. Otherwise, adopt the most recently active session whose `stageId` is the
 *    course in `?course=`.
 * 4. If no session belongs to that course, show a draft. Never borrow a session
 *    from another course.
 *
 * An attached store session only settles this decision when it belongs to the
 * requested course. A known session for another course is stale navigation
 * state, not evidence that the classroom already has the right chat.
 */

export type CourseChatBootstrap =
  /** Nothing to do: no course open, or a conversation is already there. */
  | { readonly kind: 'settled' }
  /** Carry this existing conversation into the middle column. */
  | { readonly kind: 'adopt'; readonly sessionId: string; readonly courseId: string }
  /** Show an empty composer; the first message creates the real session. */
  | { readonly kind: 'draft'; readonly courseId: string };

/** The shape this resolver needs from a session row. */
export interface AdoptableSession {
  readonly id: string;
  readonly stageId?: string | null;
  readonly updatedAt?: number;
  readonly createdAt?: number;
}

/** How recent a row is, tolerating a list that carries only one of the stamps. */
function recency(session: AdoptableSession): number {
  return Math.max(Number(session.updatedAt) || 0, Number(session.createdAt) || 0);
}

/**
 * The conversation to carry over: the most recently active row.
 *
 * `updatedAt` rather than `createdAt`, so "the one I was just in" wins over "the
 * one I opened last week and never touched"; the id breaks ties so the choice is
 * deterministic rather than dependent on list order.
 */
export function mostRecentSession<T extends AdoptableSession>(sessions: readonly T[]): T | null {
  let best: T | null = null;
  for (const session of sessions) {
    if (!session.id) continue;
    if (!best) {
      best = session;
      continue;
    }
    const stamp = recency(session);
    const bestStamp = recency(best);
    if (stamp > bestStamp || (stamp === bestStamp && session.id > best.id)) best = session;
  }
  return best;
}

export function resolveCourseChatBootstrap(input: {
  /** The course in the classroom pane (`?course=`). */
  readonly courseId: string | null;
  /** The conversation the URL asks for (`?session=`). */
  readonly sessionId: string | null;
  /**
   * The conversation the store is actually attached to. Usually the same as
   * `sessionId`; it is read as well so the brief window during navigation -
   * when the URL has dropped `?session=` but the store has not detached yet -
   * cannot be mistaken for "there is no conversation".
   */
  readonly attachedSessionId?: string | null;
  /**
   * The user just asked for a NEW conversation while a course was open.
   * This outranks adoption so "new chat" does not immediately reopen the
   * conversation it was meant to leave.
   */
  readonly newConversationRequested?: boolean;
  /** The owner's conversations, as the rail knows them. */
  readonly sessions: readonly AdoptableSession[];
  /**
   * Has that list actually arrived? Until it has, neither branch is knowable:
   * deciding 'draft' early would flash an empty composer over a user who has
   * fifty conversations.
   */
  readonly sessionsLoaded: boolean;
}): CourseChatBootstrap {
  const {
    courseId,
    sessionId,
    attachedSessionId = null,
    newConversationRequested = false,
    sessions,
    sessionsLoaded,
  } = input;
  if (!courseId) return { kind: 'settled' };
  // A conversation explicitly selected in workspace state is already open. It
  // does not matter which course it is about: that pairing is the user's to
  // make, and this must never replace it.
  if (sessionId) return { kind: 'settled' };
  if (newConversationRequested) return { kind: 'draft', courseId };
  if (!sessionsLoaded) return { kind: 'settled' };

  // A session not present in the loaded owner list may be the freshly attached
  // session from the render before the list catches up. Keep it until it can be
  // identified; a known session for a different course must not get that grace.
  const attached = attachedSessionId
    ? sessions.find((session) => session.id === attachedSessionId)
    : undefined;
  if (attachedSessionId && !attached) return { kind: 'settled' };
  if (attached?.stageId === courseId) return { kind: 'settled' };

  const courseSession = mostRecentSession(
    sessions.filter((session) => session.stageId === courseId),
  );
  return courseSession
    ? { kind: 'adopt', sessionId: courseSession.id, courseId }
    : { kind: 'draft', courseId };
}
