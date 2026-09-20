---
name: translation-feedback-export-is-corpus-only
description: The fine-tuning corpus export reads the SIGNAL table only; the operator page and the CLI inherit that rule, and a unit test reads the module's source to enforce it
metadata:
  type: project
---

`app/lib/reports/translation-feedback-export.server.ts` is the fine-tuning
corpus: one function, `buildTranslationFeedbackExport({ db, verdict })`, two
record kinds behind a `verdict` discriminant (`rejected` per run,
`endorsed` per edge at `VOTE_MARGIN_THRESHOLD`, imported from `rank.ts` and
never re-stated).

It may never touch `translation_rejections`. The count of rejections is a count
of SIGNAL rows, and `recordRejection` writes one signal per genuinely new fact
row, so the number is identical WITHOUT the account column entering a statement.
The same rule binds the `/super/llm` "Rejected translation runs" block and both
`pnpm cli translation feedback` / `export-feedback`.

**Why:** the two-table split IS the feature (see
[[project_rejection_split_fact_and_signal]]). A join added for "how many
distinct readers" collapses it with no bug and no other change.

**How to apply:** `tests/unit/translation-feedback-export-names-no-reader.test.ts`
strips comments, then bans `translationRejections` / `translation_rejections`
and `accountId` / `account_id` in the module's code, and scans every exported
interface field for `/account|user|session|ip/i`. Comments naming the forbidden
table are deliberately allowed, so state the rule in prose there.
