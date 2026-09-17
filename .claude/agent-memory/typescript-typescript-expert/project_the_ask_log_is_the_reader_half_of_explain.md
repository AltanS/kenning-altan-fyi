---
name: the-ask-log-is-the-reader-half-of-explain
description: explanation_asks carries the reader, explanations stays readerless, and the two join in memory on the cache key with a unit test guarding the absence
metadata:
  type: project
---

Explain has TWO tables. `explanations` is the readerless ledger and cache, keyed
by `(from, to, question_normalized)`. `explanation_asks` is the reader's own log,
`(user_id, from_language, to_language, question_normalized)` unique, upserted by
`/explain`'s loader AFTER the panel resolves and whatever the panel says.

**Why:** the local "saved explanations" collection M198 proposed first was
retired before it shipped, because a keep button almost nobody presses is not how
a reader gets their question back. Storing by default needs a reader on a row,
and putting one on the ledger would make the second reader of a cached answer
indistinguishable from its author.

**How to apply:**
- There is NO foreign key between the two and there must not be. The list screen
  joins them in memory on the cache key, through `explanationStandings`, which is
  two `DISTINCT ON` queries for a whole page rather than two per row, and which
  applies `resolveExplainPanel`'s own precedence (an answered row beats a later
  failed one) so the list and the page it links to agree.
- `tests/unit/explanation-asks-schema.test.ts` asserts the ABSENCE of `user_id`
  on `explanations`, off Drizzle's `getTableConfig`. Adding one to make a join
  easy is the regression that reads as a convenience.
- The length cap is the only thing that stops the write: a question over
  `EXPLAIN_MAX_QUESTION_CHARS` opens no run and could never be answered.
- `/explanations/:id` resolves the panel READ-ONLY (`resolveExplainPanel`, no
  request in scope, cannot enqueue) and drives the SAME `useExplainPane`
  controller as the inline card, so pending and failed rows poll and retry there.
- `getExplanationAsk`/`removeExplanationAsk` put the user IN the where clause, so
  another account's row is a 404 rather than a check somebody can forget.

See [[explain-is-the-third-sibling-m198]], [[synced-collection-has-nine-seams]].
