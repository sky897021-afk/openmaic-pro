# Educational Game Widget Generator

Generate a self-contained HTML game that is FUN, ENGAGING, and EDUCATIONAL.

## Core Principle: GAMES, NOT QUIZZES

**CRITICAL: Avoid boring multiple-choice quizzes!** Students already have enough tests. Create games that are:
- **Interactive**: Players DO something, not just click answers
- **Skill-based**: Success depends on player action, not just knowing the answer
- **Engaging**: Fun mechanics that make students want to play more
- **Meaningful simulation**: If there's a visual simulation, it MUST be part of the gameplay

## Teaching Mini-Game Contract (READ FIRST)

{{#if isSingleLesson}}
This widget is the **entire lesson** — the student sees one page, this game.
{{/if}}
{{#if isLevelSeries}}
This widget is **level {{levelNumber}} of {{levelTotal}}** in a game series. The
student reaches the other levels from a list and may play them in any order, so
this page is responsible for exactly one teaching objective — and responsible for
that one completely. Everything below is shared; the rules marked *series only*
are what makes a level different from a whole-lesson game.
{{/if}}

That changes what "good" means:

1. **Every mechanic encodes a teaching point.** The supplied Key Points ARE the
   game's rules and win conditions. Do not put the material on the page as text.
2. **The player must demonstrate understanding**, not just reflex. A player who
   ignores the concept must be able to lose because of it.
3. **Failures must be diagnosable.** Every way to fail maps to a specific Key
   Point, so the post-game report below can say *which* concept the student got
   wrong and *why*.
4. **One self-contained page.** No tabs, no external resources, no navigation.
{{#if isLevelSeries}}
5. *(series only)* **This level is not the course.** Teach only the objective on
   this page. Never summarise, preview, or test the other {{levelTotal}} levels'
   material, and never gate anything behind finishing this one — levels are
   independent.
6. *(series only)* **Go deep, not wide.** One objective, explored further than a
   single all-in-one game could: a real failure state, mechanics that exercise
   every Key Point on this page, and feedback that traces a failure back to the
   one that was missed. Do NOT build a multi-stage walkthrough of the whole
   subject — that is a different mode's shape, not this one.
7. *(series only)* **Show the level indicator.** The start screen and the result
   screen both display which level this is, written in the teaching language
   ("第 {{levelNumber}} / {{levelTotal}} 关", "Level {{levelNumber}} of
   {{levelTotal}}"). Never leave it in English when the teaching language is not
   English.
{{/if}}

## Game Types (PREFER THESE OVER QUIZ)

### 1. Physics/Action Games (HIGHLY RECOMMENDED)
- **Timing games**: Click at the right moment to hit a target
- **Aim and launch**: Adjust angle/power to hit targets
- **Balance games**: Keep an object balanced or in motion
- **Catch/avoid games**: Move to catch falling objects or avoid obstacles
- **Example**: Instead of asking "What force is needed?", let players ADJUST thrust and SEE if they land safely

### 2. Drag-and-Drop Puzzles
- Sort items into correct categories
- Arrange steps in correct order
- Match pairs by dragging
- Build structures by placing pieces

### 3. Interactive Simulations as Games
- Let players ADJUST parameters and see results
- Challenge: "Land the spacecraft safely" - player controls thrust
- Challenge: "Reach the target" - player adjusts angle and power
- Challenge: "Balance the forces" - player adds/removes weights

### 4. Card/Matching Games
- Memory match with concept pairs
- Flashcard flip to reveal answers
- Sorting cards into categories

### 5. Strategy/Decision Games
- Turn-based decisions with consequences
- Resource management challenges
- Multi-step problem solving

## When Quiz is Unavoidable

If you MUST include quiz elements:
- Make it INTERACTIVE (drag answer to target, not click radio button)
- Add PHYSICS/ACTION component (answer unlocks next gameplay)
- Use VISUAL questions (identify the diagram, not text questions)
- Keep questions SHORT and FEW (max 3-5)
- Include EXPLANATION as gameplay reward, not punishment

## Simulation-Game Integration (CRITICAL)

If your game has a visual simulation, it MUST be:
1. **Interactive**: Player controls something in the simulation
2. **Meaningful**: Player's actions affect the outcome
3. **Aligned with learning**: The physics/concept being taught is what the player manipulates

### BAD Example:
```
Question: "What thrust is needed for 1000kg at 9.8m/s²?"
Options: [4900N, 9800N, 19600N, 0N]
Player clicks answer → Animation plays (success or failure)
```
Problem: Simulation is just decoration. Player doesn't interact with it.

### GOOD Example:
```
Game: "Land the spacecraft safely"
Player controls: Thrust slider (0-15000N)
Real-time physics: Spacecraft falls at rate determined by (thrust - mass*g)
Challenge: Adjust thrust to land at velocity < 5m/s
Feedback: Visual speedometer shows current velocity
Learning: Player EXPERIENCES F=ma by adjusting thrust and seeing result
```

## Widget Config Schema

```json
{
  "type": "game",
  "gameType": "action",
  "description": "...",
  "gameConfig": {
    "controls": ["thrust_slider", "angle_adjuster"],
    "targets": [
      { "id": "t1", "type": "landing_zone", "x": 300, "width": 100, "maxVelocity": 5 }
    ],
    "initialConditions": {
      "mass": 1000,
      "gravity": 9.8,
      "altitude": 500,
      "initialVelocity": 0
    },
    "successCondition": "landingVelocity < 5",
    "levels": [...]
  },
  "scoring": {
    "completionPoints": 50,
    "accuracyBonus": "lower velocity = more points",
    "timeBonus": true
  },
  "achievements": [
    { "id": "soft_landing", "name": "Butter Landing", "description": "Land at < 2m/s", "icon": "🦋" }
  ]
}
```

## Technical Requirements

- Real-time game loop with `requestAnimationFrame`
- Touch-friendly controls (sliders, buttons, drag areas)
- Clear visual feedback (score, progress, status)
- Achievement popups
- Level progression
- localStorage for progress
- Pause/resume functionality
- Clear instructions before game starts

## Fair Start Requirements (CRITICAL)

**NEVER let the player fail immediately when the game starts!**

### Mandatory Rules:
1. **Grace Period**: First 3-5 seconds should be safe - no failure conditions apply
2. **Safe Initial State**: Player must be able to survive at least 10 seconds with default settings
3. **No Instant Collision**: Game objects should start in safe positions, away from danger zones
4. **Reasonable Physics**: Initial velocities must allow stable gameplay, not immediate crash

### For Physics-Based Games:
- Calculate stable orbital/trajectory parameters BEFORE setting initial values
- Verify: `initial_velocity >= sqrt(GM/r)` for orbital games
- Test: Player not touching any danger zone at start
- Ensure: Default control values (e.g., thrust at 100%) result in survivable state

### BAD Example (Player fails instantly):
```javascript
// Earth starts at distance 250 from sun
// Initial velocity: 2.4 (way too low for orbit)
// Player clicks "Start" → Earth immediately falls into sun → "Mission Failed"
```

### GOOD Example (Player has time to react):
```javascript
// Earth starts at distance 250 from sun
// Initial velocity: calculated for stable orbit ≈ sqrt(1500*200/250) ≈ 35
// OR: Start with grace period where collision is disabled for 3 seconds
// Player can adjust thrust before any danger
```

## Layout & Positioning (CRITICAL)

### Game Object Positioning
When calculating positions for game objects (lander, player, targets), account for UI overlays:

```javascript
// BAD: Object overlaps with controls/HUD
const objectY = groundY - (altitude / maxHeight) * canvas.height;

// GOOD: Reserve space for UI elements
const TOP_MARGIN = 100;    // Space for HUD/stats at top
const BOTTOM_MARGIN = 250; // Space for controls at bottom
const playableHeight = canvas.height - TOP_MARGIN - BOTTOM_MARGIN;
const objectY = groundY - BOTTOM_MARGIN - (altitude / maxHeight) * playableHeight;
```

### Control Panel Sizing
- Don't let controls take more than 30% of screen height
- On mobile, consider collapsible controls or side-by-side layout
- Test that the main game object is always visible

### Canvas vs UI Layers
- Canvas should fill the container but NOT overlap with fixed UI
- Use padding or margins to create "safe zones" for game objects
- Position game objects within the visible canvas area, not under overlays

## CRITICAL: postMessage Listener for Widget Actions (REQUIRED)

The platform drives this widget by posting messages into the iframe
(`SET_WIDGET_STATE`, `HIGHLIGHT_ELEMENT`, `ANNOTATE_ELEMENT`, `REVEAL_ELEMENT`).
Your HTML MUST register this listener, or those actions silently do nothing.
Register it at the end of the body (or inside your DOMContentLoaded setup) so the
game can be driven the same way a player would drive it:

```javascript
window.addEventListener('message', function(event) {
  const { type, target, state, content } = event.data;

  switch (type) {
    case 'SET_WIDGET_STATE':
      // Apply state to controls / game params. Keys map to controls by id;
      // route to the game via a global setter when one exists.
      if (state) {
        Object.entries(state).forEach(([key, value]) => {
          const control = document.getElementById(key + '-slider') || document.getElementById(key) || document.querySelector('[data-var="' + key + '"]');
          if (control) {
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (typeof window.setGameParam === 'function') window.setGameParam(key, value);
        });
      }
      break;

    case 'HIGHLIGHT_ELEMENT':
      const highlightEl = document.querySelector(target);
      if (highlightEl) {
        highlightEl.style.outline = '3px solid rgba(139, 92, 246, 0.8)';
        highlightEl.style.outlineOffset = '4px';
        highlightEl.style.animation = 'pulse-highlight 2s infinite';
        setTimeout(() => {
          highlightEl.style.outline = '';
          highlightEl.style.animation = '';
        }, 3000);
      }
      break;

    case 'ANNOTATE_ELEMENT':
      const annotateEl = document.querySelector(target);
      if (annotateEl && content) {
        const rect = annotateEl.getBoundingClientRect();
        const tooltip = document.createElement('div');
        tooltip.className = 'teacher-annotation';
        tooltip.style.cssText = 'position:fixed; top:' + (rect.top - 40) + 'px; left:' + rect.left + 'px; background:rgba(139,92,246,0.95); color:white; padding:8px 12px; border-radius:8px; font-size:14px; z-index:1000; animation:fadeIn 0.3s;';
        tooltip.textContent = content;
        document.body.appendChild(tooltip);
        setTimeout(() => tooltip.remove(), 4000);
      }
      break;

    case 'REVEAL_ELEMENT':
      const revealEl = document.querySelector(target);
      if (revealEl) {
        revealEl.style.display = '';
        revealEl.style.opacity = '1';
      }
      break;
  }
});

const style = document.createElement('style');
style.textContent = '@keyframes pulse-highlight { 0%, 100% { outline-color: rgba(139, 92, 246, 0.8); } 50% { outline-color: rgba(139, 92, 246, 0.4); } } @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }';
document.head.appendChild(style);
```

### Element Naming Convention

So highlight/annotate/reveal can target controls, use consistent ids:
- Sliders: `id="{param}-slider"` (e.g., `id="thrust-slider"`)
- Buttons: `id="{action}-btn"` (e.g., `id="start-btn"`, `id="reset-btn"`)
- If game parameters live only in JS state, expose `window.setGameParam(key, value)`
  so `SET_WIDGET_STATE` can drive them.

## Post-Game Report (MANDATORY — NOT OPTIONAL)

When the game ends (win, loss, or timeout) the game MUST show a **Result Screen**
and MUST score the student and summarise their mistakes. This is a core
requirement of this widget, not a bonus.

### 1. Track every mistake as it happens

Maintain a mistake log and push one entry at the moment of each wrong action:

```javascript
const mistakeLog = [];
function recordMistake(keyPoint, playerAction, correctAction, reason) {
  mistakeLog.push({ keyPoint, playerAction, correctAction, reason });
}
```

- `keyPoint` — which supplied Key Point the mistake violates (use the Key Point
  text verbatim).
- `playerAction` — what the student actually did (e.g. "thrust 4000N").
- `correctAction` — what they should have done (e.g. "thrust > 9810N to ascend").
- `reason` — one sentence, in the teaching language, explaining *why* that is
  wrong. This is the teaching moment.

Do NOT record the same mistake repeatedly for a single continuous error.

### 2. Score the student (0–100)

Score against the Key Points — they are the rubric. Suggested weighting:

| Dimension | Weight | Meaning |
|---|---|---|
| Concept accuracy | 50% | fraction of Key Points never violated |
| Goal completion | 30% | did the player achieve the objective (and how cleanly) |
| Efficiency | 20% | attempts / time / wasted actions |

Show the total score, a grade label (`优秀 / 良好 / 及格 / 需加油`, or
equivalents in the teaching language), and one encouraging sentence.

### 3. Summarise the mistakes

The Result Screen MUST list every logged mistake, each showing:

- the Key Point it belongs to,
- what the student did,
- the correct approach,
- the one-sentence reason.

Then give **1–3 改进建议**, targeting the most-violated Key Points. If the
student made no mistakes, say so explicitly and congratulate them — do not
render an empty list.

#### Ranking the most-violated Key Points

`mistakeLog` is an ARRAY of entries; ranking needs a second, different
structure — a count per Key Point. Use this shape:

```javascript
const violationCount = {};                    // OBJECT: Key Point text -> number
for (const m of mistakeLog) {
  violationCount[m.keyPoint] = (violationCount[m.keyPoint] || 0) + 1;
}
const topKeyPoints = Object.keys(violationCount)   // ARRAY of Key Point strings
  .sort((a, b) => violationCount[b] - violationCount[a])
  .slice(0, 3);
if (topKeyPoints.length === 0) { /* no mistakes — congratulate instead */ }
```

Two rules, both mandatory:

- **The counter is an object; the ranking is an array. Keep them in separate
  variables, and never call an array method on the counter.** `.slice()`,
  `.push()`, `.map()`, `.filter()` do not exist on a plain object — calling one
  throws a `TypeError` that kills the entire result screen. To turn the counter
  into a list, call `Object.keys(...)` first.
- **A comparator must actually compare.** `function(a, b) { return 0; }` is
  valid JavaScript that silently disables sorting — never emit it, not even as
  a placeholder. Return a real ordering, as above.

### 4. Result Screen requirements

- Render it as an **in-page overlay**, never `alert()` / `confirm()` (the widget
  runs in a sandboxed iframe where those are blocked).
- Use plain custom CSS, mobile-friendly, scrollable if the report is long.
- Include a **重新开始 / Play Again** button.
- **Build the report inside a `try/catch`.** Scoring, aggregating and sorting
  all run here; if any of them throws, show a short fallback line and still
  reveal the result screen. The student must never be left on a dead page that
  ignores further clicks.
- **The way out must not depend on the report succeeding.** Bind the
  **重新开始 / Play Again** handler before the report is rendered, or in a
  `finally` block, so a failed report still leaves a working button.
- All text in the teaching language.
- The report must be readable without any external network request.

### 5. Emit the result to the host page (cheap, do it always)

```javascript
window.parent.postMessage({
  type: 'maic:game-result:v1',
  payload: {
    score: totalScore,          // 0-100
    grade: gradeLabel,
    accuracy: conceptAccuracy,  // 0-1
    attempts: attemptCount,
    durationMs: Date.now() - startTime,
    mistakes: mistakeLog,       // [{ keyPoint, playerAction, correctAction, reason }]
  },
}, '*');
```

The host may ignore this; never make the report depend on it being received.

{{#if isLevelSeries}}
This page reports **only its own level**. The series keeps one overall score sheet
across all {{levelTotal}} levels and the host does the aggregating, so emit this
level's score exactly as measured — do not invent a series total, a running
average, or a grade for the course as a whole.
{{/if}}

## Output Format (CRITICAL)

**Return EXACTLY ONE HTML document.** Do NOT:
- Duplicate the HTML content
- Include multiple `<!DOCTYPE html>` tags
- Append a second copy of the document

Output structure must be:
```html
<!DOCTYPE html>
<html>
<head>...</head>
<body>...</body>
</html>
<!-- END - Nothing after this -->
```

If you catch yourself duplicating content, STOP and output only the first complete document.

## Engagement Features

1. **Immediate feedback**: Player knows instantly if action was right/wrong
2. **Visual rewards**: Animations, particles, sounds for success
3. **Progression**: Levels get progressively harder
4. **Replayability**: Random elements, multiple paths to success
5. **Challenge variety**: Different objectives (speed, accuracy, efficiency)
6. **High scores**: Track best performance

## Output Format

Return ONLY the HTML document, no markdown fences or explanations.

## Quality Checklist (verify before output)

- [ ] Game is INTERACTIVE, not just a quiz
- [ ] Player CONTROLS something meaningful
- [ ] Simulation (if present) is part of gameplay, not decoration
- [ ] Success depends on player SKILL, not just knowledge
- [ ] **Fair Start: Player cannot fail in first 3-5 seconds**
- [ ] **Initial parameters allow survival with default settings**
- [ ] Visual feedback is immediate and clear
- [ ] Game is FUN to play (would you play it more than once?)
- [ ] Learning happens through PLAY, not through questions
- [ ] Touch-friendly controls for mobile
- [ ] Clear instructions at game start
- [ ] Achievement system provides motivation
- [ ] **NO DUPLICATED HTML** - exactly ONE `<!DOCTYPE html>` tag
- [ ] Game objects are VISIBLE and not hidden under UI overlays
- [ ] Positioning accounts for control panel and HUD heights
- [ ] **Every mechanic encodes a supplied Key Point (teaching mini-game, not a toy)**
- [ ] **Post-game Result Screen exists: 0-100 score + grade + encouraging line**
- [ ] **Mistake log records keyPoint / playerAction / correctAction / reason**
- [ ] **Every logged mistake appears in the report with a one-sentence reason**
- [ ] **1-3 改进建议 derived from the most-violated Key Points**
- [ ] **Result emitted via `maic:game-result:v1` postMessage**
- [ ] **"Play Again" button restarts the game and clears the mistake log**
- [ ] **Every sort comparator really compares — none is `return 0`**
- [ ] **No array method is called on the mistake counter, and the result screen renders inside `try/catch` so a rendering error cannot trap the player**
{{#if isLevelSeries}}
- [ ] **Series only: only THIS level's objective is taught and tested**
- [ ] **Series only: no walkthrough of the whole subject, no gating on other levels**
- [ ] **Series only: level indicator "{{levelNumber}} / {{levelTotal}}" shown in the teaching language**
- [ ] **Series only: reports this level's score only — no invented series total**
{{/if}}

## Critical Technical Requirements (MANDATORY)

### 1. Event Binding: Use Inline onclick for Start Button
**ALWAYS use inline onclick for the game start button.** This is more reliable than addEventListener.

```html
<!-- CORRECT: Inline onclick - guaranteed to work -->
<button onclick="startGame()">开始游戏</button>

<!-- WRONG: addEventListener can fail if script has errors -->
<button id="start-btn">开始游戏</button>
<script>
  // If any error occurs before this line, click does nothing
  document.getElementById('start-btn').addEventListener('click', startGame);
</script>
```

**Rule**: For critical game-start buttons, use inline onclick. For other UI elements, you may use addEventListener inside a DOMContentLoaded wrapper.

### 2. CSS: Prefer Custom CSS Over Tailwind CDN
**Use custom CSS instead of Tailwind CDN for game widgets.** Tailwind CDN with `@layer utilities` may not compile correctly, causing elements to be unstyled or invisible.

```html
<!-- CORRECT: Custom CSS - reliable and predictable -->
<style>
  .game-button { background: #3498db; padding: 12px 30px; }
</style>

<!-- WRONG: Tailwind @layer utilities may fail -->
<style type="text/tailwindcss">
  @layer utilities { .game-button { @apply bg-blue-500 px-6; } }
</style>
```

**Exception**: You may use basic Tailwind utility classes (like `flex`, `text-center`) directly on elements, but avoid `@layer utilities` blocks.

### 3. Script Placement: Wrap in DOMContentLoaded or Place at End
**Either wrap the entire game script in DOMContentLoaded, or place it at the very end of body.**

```html
<!-- Option A: DOMContentLoaded wrapper -->
<script>
document.addEventListener('DOMContentLoaded', function() {
  // All game code here - elements are guaranteed to exist
  const canvas = document.getElementById('gameCanvas');
  function startGame() { ... }
});
</script>

<!-- Option B: Script at end of body (after all elements) -->
</body>
<!-- No elements after this point -->
</html>
```

### 4. Global Functions for onclick Handlers
**Functions called by inline onclick must be globally accessible.**

```javascript
// CORRECT: Define function globally (outside DOMContentLoaded)
function startGame() {
  document.getElementById('start-screen').classList.add('hidden');
  gameActive = true;
  initLevel();
}

// If using DOMContentLoaded, expose function to window
document.addEventListener('DOMContentLoaded', function() {
  // ... other setup ...
});
// Define startGame outside or assign to window
window.startGame = function() { ... };
```

### 5. Simple Initialization Flow
**The game initialization should be simple and direct:**

```javascript
function startGame() {
  // 1. Hide start overlay
  document.getElementById('start-screen').classList.add('hidden');
  // 2. Set game state
  gameActive = true;
  startTime = Date.now();
  // 3. Initialize first level
  initLevel();
  // 4. Start game loop
  requestAnimationFrame(gameLoop);
}
```

**Avoid**: Complex dependencies like reading localStorage before events are bound, multiple async operations during init, or chained promises for game start.


{{snippet:interactive-observation}}
