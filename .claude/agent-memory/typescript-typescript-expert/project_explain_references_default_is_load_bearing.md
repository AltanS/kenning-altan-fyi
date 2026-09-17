---
name: explain-references-default-is-load-bearing
description: Kenning re-parses the stored explanation jsonb on EVERY read, so a new field on explanationSchema must be .default() or every cached answer stops decoding
metadata:
  type: project
---

A new field on `app/lib/llm/explain-schema.ts` must carry `.default(...)`, never
be plain required. `references` (prompt v2, M198) is the first one.

**Why:** `toAnswer` in `app/models/explanations.server.ts` runs
`explanationSchema.safeParse` over the stored `jsonb` on every read, and a row
that fails becomes `answer: null`. `resolveExplainPanel` reads that as `none`,
which the trigger half treats as "nobody has asked this", so it queues and PAYS
for a question the installation already answered. A required field would do that
to every row written under the previous prompt version at once, with no error
anywhere. Bumping `EXPLAIN_PROMPT_VERSION` does not help: the version is part of
the dedupe key, not of the read.

**How to apply:** `.default([])` for a list, `.optional()` or `.nullable()` for a
scalar. The card then needs no tolerance code, because the parse guarantees the
field. Mirrors the same rule on `translations.note` and on `history.translation`
in `backup.ts`. See [[explain-is-the-third-sibling-m198]].
