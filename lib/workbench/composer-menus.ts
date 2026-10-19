/**
 * Which of the composer's three popovers is open — one rule, one answer.
 *
 * The composer has exactly three: the `/` skill menu, the `@` course menu, and
 * the material-library picker. They live in the same box, own the same keys
 * while open (↑/↓/Enter/Escape) and must never both be showing. The rule is
 * stated once, here, and it is pure:
 *
 *  - a live `/` query wins the slot — it is the thing being typed right now;
 *  - otherwise the library shows if its button asked for it — a press is the
 *    most recent intent, and it is the only one of the three with no token in
 *    the draft to reopen it;
 *  - otherwise the `@` menu shows, either because a token in the draft asks for
 *    it or because the button did;
 *  - a menu dismissed ON A GIVEN DRAFT stays dismissed for exactly that text.
 *
 */
import { courseMentionQuery, type CourseMention } from './course-mention';
import { slashQuery } from './composer-skills';

export type ComposerMenu = 'skill' | 'course' | 'library' | null;

export interface ComposerMenuState {
  readonly menu: ComposerMenu;
  /** The `/` query, when the skill menu is the one open. */
  readonly slash: string | null;
  /** The `@` token in the draft, when there is a live one. */
  readonly mention: CourseMention | null;
}

export function resolveComposerMenu(input: {
  readonly draft: string;
  /**
   * The textarea's live `selectionStart`. Both triggers read the token AROUND it.
   */
  readonly caret: number;
  /** The draft the `/` menu was last dismissed on. */
  readonly slashDismissedOn?: string | null;
  /** The draft the `@` menu was last dismissed on. */
  readonly mentionDismissedOn?: string | null;
  /** The `@` button was pressed and has not been dismissed since. */
  readonly courseMenuRequested?: boolean;
  /**
   * The material-library button was pressed and has not been dismissed since.
   *
   * Outranks the `@` menu's request: both are a button press, and a press with
   * no draft token behind it would otherwise be indistinguishable from "nothing
   * happened" while an `@` token sits in the draft.
   */
  readonly libraryMenuRequested?: boolean;
  /**
   * False where there is nothing to offer — a launch surface whose course list is
   * empty.
   */
  readonly courseMenuAvailable?: boolean;
}): ComposerMenuState {
  const {
    draft,
    caret,
    slashDismissedOn = null,
    mentionDismissedOn = null,
    courseMenuRequested = false,
    libraryMenuRequested = false,
    courseMenuAvailable = true,
  } = input;
  const slash = draft === slashDismissedOn ? null : slashQuery(draft, caret);
  const mention = draft === mentionDismissedOn ? null : courseMentionQuery(draft, caret);
  if (slash !== null) return { menu: 'skill', slash, mention: null };
  if (libraryMenuRequested) return { menu: 'library', slash: null, mention };
  const dismissedOnThisDraft = draft === mentionDismissedOn;
  const course =
    courseMenuAvailable && !dismissedOnThisDraft && (mention !== null || courseMenuRequested);
  return { menu: course ? 'course' : null, slash: null, mention };
}
