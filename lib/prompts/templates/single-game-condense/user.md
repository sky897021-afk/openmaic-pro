A first pass produced **{{sceneCount}} scenes** for a lesson that must be
**one page**. Condense them into that one teaching mini-game, and account for
every scene you were given.

---

## User Requirements

{{requirement}}

---

## Teaching Language

{{languageDirective}}

---

## The scenes ({{sceneCount}})

```json
{{scenes}}
```

{{#if correction}}
---

## Correction required

Your previous response was rejected: {{correction}}

Answer again with the same two top-level keys, `outline` and `dispositions`.
`dispositions` must hold exactly {{sceneCount}} entries — one per input scene
above, numbered 1 to {{sceneCount}}, none repeated, none missing.
{{/if}}

---

## Your Task

Return one JSON object with two keys:

1. **`outline`** — the single teaching mini-game that carries this lesson. It is
   a `"type": "interactive"`, `"widgetType": "game"` scene with a
   `widgetOutline` naming its concept, gameType, challenge and playerControls,
   and two to five testable `keyPoints`. Design the mechanic so that success
   requires understanding the material, and so that a failure can be traced back
   to a specific `keyPoints` entry.
2. **`dispositions`** — {{sceneCount}} entries, one per scene above, each
   `{ "index": <1-based input number>, "disposition": "folded" | "redundant" |
   "non-teaching", "note": "<short reason>" }`.

Everything in the game must come from the scenes above. Do not add a topic the
first pass did not raise, and do not carry the material over as text on the
page — encode it into the gameplay.

**Final reminder**: a JSON **object** with exactly two top-level keys,
`outline` (one game scene) and `dispositions` ({{sceneCount}} items). No prose,
no code fences, no bare array, and no `languageDirective` or `courseTitle`.