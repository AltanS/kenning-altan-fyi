---
name: quiz-scaffold-reclaimable-run-row
description: quiz_scaffold_runs (M203) is a single mutable row per key, not an append-only ledger; ON CONFLICT DO NOTHING alone strands it on any refusal
metadata:
  type: project
---

`quiz_scaffold_runs` (`drizzle/schema/quiz.ts`) has a composite PK on
`(from_language_code, to_language_code)`, one row per pair, ever. It was
originally built with `claimScaffoldRun` doing plain
`INSERT ... ON CONFLICT DO NOTHING`, which means the FIRST row ever written
for a pair, even a `budget`-refused or no-provider-key `failed` one, blocks
every later claim permanently: there is no append-only fallback the way
`translation_runs` has (a fresh row per attempt). Fixed in M203's post-hoc
review (2026-09-21) by making the claim `ON CONFLICT ... DO UPDATE ... WHERE
status IN ('failed', 'budget')` (Drizzle's `onConflictDoUpdate({ target, set,
setWhere })`, not `where`/`targetWhere`), so a dead-end status resets to
`pending` and is reclaimed, while `pending`/`ok` rows are left untouched
(Postgres skips the UPDATE entirely when `setWhere` doesn't match, so
`.returning()` comes back empty and the caller correctly reads "not claimed").

The matching bug: the enqueue path (`app/lib/quiz/scaffold-enqueue.server.ts`)
claimed the row, then called `orchestrator.start()` and swallowed a throw with
only a log line, permanently burning the one-shot claim if the pg-boss send
itself failed. Fix: on that catch, call `finishScaffoldRun(db, key, { status:
'failed', error })` to put the row back into the reclaimable set.

**Why this matters beyond this table.** Any future single-mutable-row dedupe
table in this codebase (one row per key, not append-only) needs the same
question asked explicitly: which statuses are truly terminal-with-no-result
(reclaimable) vs terminal-with-a-result (must stay locked)? A plain `DO
NOTHING` treats every status as permanently locked, which is silently wrong
the moment ANY status means "nothing was written."

See [[project_kenning]] and `.adr/0012-quiz-scaffold-is-not-dictionary-data.md`.
