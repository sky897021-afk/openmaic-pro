Create an educational GAME widget for: {{title}}

{{#if isLevelSeries}}
## Series Position

This page is **level {{levelNumber}} of {{levelTotal}}** in a teaching game
series. The series covers the whole course, one teaching objective per level;
this page covers only the objective named below, and the student can reach the
other levels without finishing this one. Do not teach, preview, or test their
material here — and do not turn this page into a walkthrough of the subject.

{{/if}}
## Game Type

{{gameType}}

## Description

{{description}}

## Key Points

{{keyPoints}}

## Scoring Configuration

{{scoring}}

## Language

{{languageDirective}}

---

Generate a FUN, INTERACTIVE HTML game with these MANDATORY features:

### Game Design (CRITICAL - NOT A QUIZ!)
1. **Interactive gameplay**: Player MUST control something meaningful (NOT just click answers)
2. **Real game mechanics**: Timing, aiming, dragging, balancing, catching, or building
3. **Skill-based success**: Outcome depends on player action, not just correct answer
4. **Engaging feedback**: Animations, sounds, visual effects for actions

### Preferred Game Types (in order of preference)
1. **Physics/Action**: Control parameters to achieve a goal (land safely, hit target, balance)
2. **Timing/Aim**: Click at right moment or adjust aim to succeed
3. **Drag-and-drop**: Sort, arrange, or build by dragging elements
4. **Simulation game**: Let player experiment with variables to find solution
5. **Card/Match**: Memory or matching games
6. **Quiz**: ONLY as last resort - make it visually interesting

### Simulation Integration (if game has visual simulation)
- Simulation MUST be interactive (player controls something)
- Simulation physics MUST match what player is learning
- Visual feedback MUST show player's progress toward goal
- Example: Don't ask "What thrust?" → LET PLAYER ADJUST thrust and see result!

### Game Elements
1. **Clear objective**: "Land safely", "Hit the target", "Sort correctly"
2. **Player controls**: Sliders, buttons, drag areas, or click targets
3. **Real-time feedback**: Score, progress bar, visual indicators
4. **Levels or challenges**: Progressive difficulty
5. **Achievement system**: Unlockable badges for accomplishments
6. **Replay value**: Random elements or multiple solutions

### Visual Design
1. Attractive theme matching the subject
2. Clear UI for controls and feedback
3. Animations for success/failure
4. Responsive layout (mobile + desktop)

### Technical (MANDATORY)
1. **Inline onclick for start button**: `<button onclick="startGame()">开始</button>` - NOT addEventListener
2. **Custom CSS preferred**: Avoid Tailwind `@layer utilities` blocks; use plain CSS
3. **DOMContentLoaded wrapper**: Wrap game code in `document.addEventListener('DOMContentLoaded', ...)`
4. **Global start function**: `function startGame()` must be callable from onclick
5. Embedded `<script type="application/json" id="widget-config">`
6. `requestAnimationFrame` for smooth animations
7. Touch-friendly controls (min 44px touch targets)
8. localStorage for progress/high scores
9. Pause functionality

### Teaching Mini-Game (MANDATORY)
{{#if isSingleLesson}}
This game IS the whole lesson — the student sees no other page. Therefore:
{{/if}}
{{#if isLevelSeries}}
This game is ONE level of a {{levelTotal}}-level series, not the whole lesson.
Therefore:
{{/if}}
1. Every mechanic must encode one of the Key Points above; do not print the material as text.
2. A student who ignores the concept must be able to fail BECAUSE of it.
3. Each failure must be attributable to a specific Key Point, so the post-game report can explain it.
{{#if isLevelSeries}}
4. Explore this level's single objective deeply — a real failure state the
   student can recover from, and mechanics that exercise every Key Point above,
   not just the first one. Breadth belongs to the other levels.
5. Show "{{levelNumber}} / {{levelTotal}}" as the level indicator on the start
   screen and the result screen, written in the teaching language.
6. Score this level only. The series keeps one overall sheet elsewhere; do not
   invent a course-wide total or average.
{{/if}}

### Post-Game Scoring & Mistake Summary (MANDATORY)
When the game ends, the game MUST score the student and summarise their mistakes.

1. **Track mistakes as they happen** into a `mistakeLog`:
   `{ keyPoint, playerAction, correctAction, reason }` — `keyPoint` uses the Key
   Point text verbatim; `reason` is one teaching-language sentence explaining why.
2. **Score 0-100** against the Key Points (they are the rubric): ~50% concept
   accuracy, ~30% goal completion, ~20% efficiency. Show a grade label and one
   encouraging sentence.
3. **Show a Result Screen** (in-page overlay — never `alert()`) listing every
   logged mistake with the Key Point, what the student did, the correct approach,
   and the reason. Then give 1-3 改进建议 for the most-violated Key Points. If
   there were no mistakes, say so and congratulate the student.
4. **Rank the most-violated Key Points without conflating two types**: the count
   per Key Point is an OBJECT, the ranking is an ARRAY — `Object.keys(count)`,
   then `.sort((a,b) => count[b] - count[a])`, then `.slice(0,3)`. Never call an
   array method on the counter. A comparator must really compare: `return 0` is
   forbidden, even as a placeholder.
5. **Build the report inside `try/catch`**, and bind "Play Again" before the
   report is rendered (or in `finally`), so a rendering error can never leave the
   student stuck on a dead page.
6. **Include a "Play Again" button** that restarts and clears the mistake log.
7. **Emit the result to the host**:
   `window.parent.postMessage({ type: 'maic:game-result:v1', payload: { score, grade, accuracy, attempts, durationMs, mistakes: mistakeLog } }, '*');`
   Never make the on-screen report depend on this message being received.

### Output
Return ONLY the HTML document. Make the game FUN enough that students want to play again!
