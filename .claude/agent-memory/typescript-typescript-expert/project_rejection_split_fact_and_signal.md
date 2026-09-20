---
name: rejection-split-fact-and-signal
description: a rejection writes two rows, the fact naming the reader and the readerless signal, and the reason tuple lives in a pure client-safe module the schema imports
metadata:
  type: project
---

Rejecting a generated translation (M-phase 1) is THREE tables in
`drizzle/schema/translation-feedback.ts`:

- `translation_rejections` — the FACT: `(run_id, account_id)` composite primary
  key, `onConflictDoNothing`, so a second press is a no-op.
- `translation_rejection_signals` — the CONTENT, with NO account column ever. It
  is the corpus tally, and one row is appended ONLY when the fact row was
  genuinely new, otherwise one reader pressing twice reads as two readers
  agreeing. `recordRejection` does both in one transaction and returns
  `{ firstTime }`.
- `retranslation_log` — a mirror of `reenrichmentLog`, grain (headword,
  direction).

A `translation_runs` row is NOT a shared-zone object the way a `translations`
edge is: the edge exists whether or not anybody searched, the run exists only
BECAUSE somebody searched. So the fact table inherits `explanation_votes`'
governance, not `translation_votes`': no admin export of the account column, no
per-account query path, no API route, no CLI command.

**The reason codes are NOT in the schema file.** `app/lib/translation/rejection.ts`
is a pure module with no imports at all (same hard rule as
`app/lib/translation/limits.ts`) holding `REJECTION_REASONS`, `RejectionReason`,
`RETRANSLATION_COOLDOWN_HOURS = 24` and `isRetranslationCooldownActive`. The
browser renders the reason buttons, and a client component importing from
`drizzle/schema` breaks ONLY the production client build while dev and typecheck
stay green. The schema file imports the tuple back and builds the check
constraint with `sql.raw`, so the constraint and the TS union cannot drift; a new
member needs a migration.

**A value `#app/*` import inside `drizzle/schema/*` works.** `drizzle:generate`
runs through `tsx`, which resolves the tsconfig `paths`. Before this file the
only `#app` imports under `drizzle/schema/` were `import type`.

Guards: `tests/unit/rejection-signals-carry-no-account.test.ts` (substring ban on
`account`/`user`, off `getTableConfig`) and `tests/unit/translation-rejection.test.ts`.

Related: [[project_the_ask_log_is_the_reader_half_of_explain]],
[[project_rr8_server_import_breaks_only_prod_client_build]].
