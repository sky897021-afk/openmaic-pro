Turn the following material into a **series of teaching mini-game levels**: one
page per teaching objective.

> **The subject of the whole series is fixed by the line below.** Every
> objective, every level, and the course title must be about it — not about a
> related field, and not about a generic study skill:
>
> ## {{requirement}}

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

1. **Segment** the material into its teaching objectives — the things a learner
   can be assessed on separately (see the worked example in the system prompt).
2. **Design one level per objective.** Each level is a self-contained teaching
   mini-game that teaches its own objective and is scored on its own
   `keyPoints`.

The page count is the objective count. Do not collapse the series into a single
page, and do not pad it with invented objectives. A document with one objective
yields exactly one page — written as a *level* (one objective, one mechanic,
scored on its own points), not as a whole-lesson progression.

### Required output shape

```json
{
  "languageDirective": "<2-5 sentence teaching-language directive>",
  "courseTitle": "<≤30 chars, teaching language, noun phrase, anchored to the material>",
  "outlines": [
    {
      "id": "game-1",
      "order": 1,
      "type": "interactive",
      "widgetType": "game",
      "title": "<level title, ≤20 chars>",
      "teachingObjective": "<the one objective this level carries>",
      "description": "<one sentence, ≤25 words>",
      "keyPoints": ["<testable point, ≤12 words>", "<testable point>"],
      "widgetOutline": {
        "concept": "<the one concept taught>",
        "gameType": "action",
        "challenge": "<concrete action goal, ≤20 words>",
        "playerControls": ["<control>"]
      }
    }
  ]
}
```

### Design rules

- One element per teaching objective, all objectives different, all traceable to
  the material. No objective split across two pages; no two objectives sharing a
  page.
- `type` must be `"interactive"` and `widgetType` must be `"game"` — a scene
  without `widgetType` + `widgetOutline` is invalid and discarded.
- `order` counts up from 1 across the whole series.
- `gameType`: prefer `"action"` or `"puzzle"`; use `"quiz"` only as a last
  resort. Vary the mechanic across levels.
- `challenge` is a concrete action for that level ("hold the temperature above
  25 °C for ten seconds"), **not** "answer the questions".
- `keyPoints` are what the player is **scored against** after the level, so
  write them as testable statements, not vague topics.
- Every game mechanic must come from the material. Do not decorate — encode.
- Levels are independent: never require clearing one to reach the next.
- Keep every field short — see the Response Budget in the system prompt.

**Final reminder**: every objective and every level must be about
**{{requirement}}** — re-read each one and drop it if it belongs to another
subject. Then return a JSON **object** with exactly three top-level keys —
`languageDirective`, `courseTitle`, `outlines` (one item per teaching
objective). No prose, no code fences, no bare array.