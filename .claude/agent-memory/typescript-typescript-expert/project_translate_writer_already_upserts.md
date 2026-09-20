---
name: translate-writer-already-upserts
description: translate-headword.ts was already idempotent before re-runs existed; the edge upserts and `written` lists only genuine inserts, proven by `xmax = 0`
metadata:
  type: project
---

`app/workflows/operations/translation/translate-headword.ts` needs NO change to
survive a re-run returning a lemma that already has an edge.

**Why:** `upsertTranslationEdge` (line ~385) does
`.onConflictDoUpdate({ target: [translations.fromSenseId, translations.toSenseId,
translations.sourceId], set: { confidence, note } })`, and the write to the
retraction ledger is guarded: `if (row?.inserted === true)
written.translations.push(row.id)`, where `inserted` is
``sql<boolean>`(xmax = 0)` ``. Postgres leaves `xmax` zero on a row it inserted
and non-zero on one it updated. `upsertTargetHeadword` does the same at line
~299, and `resolveTargetSense` reuses the oldest sense rather than minting one.

**How to apply:** the `written` contract in `drizzle/schema/translation-runs.ts`
("only rows the run genuinely INSERTED") is already enforced at the statement,
not by a later filter. Do not add a pre-read "does this edge exist" check: that
is a second moment, and the upsert is what makes a re-run idempotent under
concurrency. Related: [[rerun-prompt-is-a-second-question]].
