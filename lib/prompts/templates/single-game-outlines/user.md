Turn the following material into **exactly one** teaching mini-game page.

---

## User Requirements

{{requirement}}

---

{{userProfile}}

## Language Context

Infer the course language directive by applying the decision rules from the system prompt:
- Requirement language = teaching language (unless overridden by explicit request or learner context)
- Foreign language learning → teach in user's native language, not the target language
- Source material language does NOT override teaching language — translate/explain it instead

---

## Source Material

### Document Content

{{pdfContent}}

{{#if hasSourceImages}}
### Available Images

{{availableImages}}
{{/if}}

### Web Search Results

{{researchContext}}

{{teacherContext}}

---

## Your Task

Design **one** teaching mini-game from the material above.

Whatever the volume of material — a single sentence or a full document — the
output is exactly **one** scene. Condense the material into the smallest set of
`keyPoints` that a single game can teach, then design a game whose mechanics
exercise those points.

### Required output shape

```json
{
  "languageDirective": "<2-5 sentence teaching-language directive>",
  "courseTitle": "<≤30 chars, teaching language, noun phrase>",
  "outlines": [
    {
      "id": "game-1",
      "order": 1,
      "type": "interactive",
      "widgetType": "game",
      "title": "<game title>",
      "description": "<what the player does and what they learn>",
      "keyPoints": ["<testable teaching point>", "<testable teaching point>"],
      "widgetOutline": {
        "concept": "<the one concept taught>",
        "gameType": "action",
        "challenge": "<concrete action goal>",
        "playerControls": ["<control>"]
      }
    }
  ]
}
```

### Design rules

- **Exactly one element in `outlines`.** Never add an introduction slide, a
  summary, a quiz, or a second game.
- `type` must be `"interactive"` and `widgetType` must be `"game"` — a scene
  without `widgetType` + `widgetOutline` is invalid and discarded.
- `gameType`: prefer `"action"` or `"puzzle"`; use `"quiz"` only as a last
  resort.
- `challenge` is a concrete action ("land under 5 m/s", "balance the arm"),
  **not** "answer the questions".
- `keyPoints` are what the player will be **scored against** after the game, so
  write them as testable statements (e.g. "thrust must exceed weight to
  ascend"), not vague topics (e.g. "Newton's laws").
- Every game mechanic must come from the material. Do not decorate — encode.
- Do not restate the source material as text on the page.

**Final reminder**: return a JSON **object** with exactly three top-level keys —
`languageDirective`, `courseTitle`, `outlines` (exactly one item). No prose, no
code fences, no bare array.