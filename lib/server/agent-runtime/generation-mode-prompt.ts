/**
 * The mode block of the workbench system prompt.
 *
 * The classic course path is two-stage: a model writes an outline, then CODE
 * coerces that outline into the requested shape (one page, or one game page per
 * objective) before any page is generated. The workbench has no outline to
 * coerce — the model plans in conversation and calls `generate_scene` directly —
 * so the mode has to be stated to the model AND enforced in the tool (see the
 * guards in `generation-tools.ts`). This file is the statement half.
 *
 * The wording deliberately reuses the shipped outline templates
 * (`lib/prompts/templates/single-game-outlines/system.md`,
 * `multi-game-outlines/system.md`) and the widget contract's vocabulary
 * (`@openmaic/generation` templates/game-content/system.md), so the agent
 * describes the same product the classic path does rather than a fourth,
 * home-grown shape. Change one and change the other.
 */
import type { GenerationMode } from '@/lib/types/generation';

const SINGLE_GAME_PROMPT = [
  '## This course is a SINGLE-PAGE TEACHING MINI-GAME',
  'The person asked for mode ②: exactly ONE page, a self-contained game that teaches the whole lesson. The mode is enforced — a second page will be refused by the tools — so plan for one from the first sentence.',
  '- The one page is `generate_scene` with `order: 1`, `type: "interactive"`, `widgetType: "game"`, and a `widgetOutline` naming the concept, gameType, challenge, and playerControls.',
  '- The amount of source material does NOT change the page count. One sentence or fifty pages of material both become this single game: condense it into one mechanic rather than expanding into pages.',
  '- There are no introduction pages, no summaries, no quizzes-as-pages, no follow-up pages. One game, one page, done.',
  '- Encode the material into the gameplay, not into text on the page: the mechanic is the thing the player manipulates.',
  '- `keyPoints` are the rubric the player is scored against after the game, so write them as testable statements, not topics.',
  '- Do not pass `seriesIndex` or `seriesTotal`: this is one whole-lesson game, not a level in a series.',
].join('\n');

const MULTI_GAME_PROMPT = [
  '## This course is a SERIES OF GAME LEVELS — one page per teaching objective',
  'The person asked for mode ③. Split the material into its teaching objectives and give each one its own page: a self-contained level that teaches that objective and scores the player against it. More material means more objectives means more pages.',
  '- Every page is `generate_scene` with `type: "interactive"` and `widgetType: "game"`; a page that is not a game is coerced into one.',
  '- A teaching objective is something a learner can be assessed on separately: one concept, relationship, procedure, or skill that can be practised and got right or wrong on its own. If a learner could master one while failing the next, they are two objectives and two pages.',
  '- Never collapse the series into a single page, and never carry a classic course over: no introduction pages, no summaries, no quizzes-as-pages, no project module.',
  '- The objectives must be traceable to the material and named in its own vocabulary. "区分基础概念与易混概念" says nothing; "区分光反应与暗反应" is an objective.',
  '- Levels are independent — the player may open any level in any order — so a level must not preview, summarise, or test another level\'s material, and must not gate anything behind finishing it.',
  '- Vary the mechanic across levels; do not make every page the same game with different words.',
  // The frozen total is what makes 「第 k / N 关」 printable: the level count is
  // baked into the page's HTML at generation time, so it cannot be backfilled
  // once later pages decide it differently.
  '- Declare the series size on EVERY `generate_scene` call: `seriesTotal` is how many levels the series will have (at least 2) and `seriesIndex` is which level this page is (1-based). Decide the total before the first page and keep it identical on every later page — the tool refuses a total that changes. These two numbers are printed on the page as 「第 k / N 关」.',
  '- If the material genuinely carries only one objective, say so and confirm with the person before planning a series; a series of one is not what this mode is for.',
].join('\n');

/**
 * The system-prompt block for a mode. Empty for classic, which is what the
 * composer already produced before modes existed and therefore needs no
 * statement — adding one would change every classic conversation's prompt for
 * no behavioural gain.
 */
export function generationModePromptBlock(mode: GenerationMode | undefined): string {
  switch (mode) {
    case 'single-game':
      return SINGLE_GAME_PROMPT;
    case 'multi-game':
      return MULTI_GAME_PROMPT;
    default:
      return '';
  }
}