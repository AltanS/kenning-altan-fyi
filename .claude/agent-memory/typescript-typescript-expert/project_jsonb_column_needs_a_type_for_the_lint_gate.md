---
name: jsonb-column-needs-a-type-for-the-lint-gate
description: A bare Drizzle jsonb column selects as unknown, which anti-slop refuses; give it .$type<JsonValue>() rather than asserting at the reader
metadata:
  type: project
---

`jsonb('col')` with no `$type` selects as `unknown`. Any function that then decodes
it takes an `unknown` parameter, which `anti-slop/no-unknown-parameters` blocks, and
the alternative is a type assertion, which `require-safety-comment-for-type-assertion`
also flags.

**Why:** the lint gate wants a named domain type at the I/O boundary, and a jsonb
column genuinely holds a `JsonValue`.

**How to apply:** `jsonb('answer').$type<JsonValue>()` in the schema, importing
`JsonValue` from `#app/lib/json`. The model's decode step then reads
`JsonValue | null` and runs `schema.safeParse` on it, with no assertion anywhere.
`drizzle/schema/explanations.ts` is the worked example. A Zod-inferred type with an
OPTIONAL field is still assignable to `JsonValue` on the insert side, so this costs
nothing at the write.
