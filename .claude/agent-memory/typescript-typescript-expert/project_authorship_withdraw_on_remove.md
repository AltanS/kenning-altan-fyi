---
name: authorship-withdraw-on-remove
description: Removing an explain ask must withdraw the reader's explanation_authorship row first, keyed on the question and not on a ready panel; the setters' own userId clause needs a direct-call test
metadata:
  type: project
---

Explain has THREE tables, not two: `explanations` (readerless ledger),
`explanation_asks` (the reader's private log) and `explanation_authorship`
(`explanation_id` PK, `listed` default true, `show_name` default false).

**Why:** `removeExplanationAsk` deletes only the private log row. The authorship
row survived a remove: still listed, still named if the byline was on, and now
unreachable because the only page carrying its switches was the ask just
deleted. Spec 03 turns listed rows public, so that is a privacy defect.

**How to apply:**

- `withdrawOwnAuthorship(db, { userId, askId })`
  (`app/lib/authorship/withdraw-own-authorship.server.ts`) runs BEFORE
  `removeExplanationAsk` in BOTH entry points, `explanations.$id.tsx`'s REMOVE
  intent and `explanations.tsx`'s list action. That order is the safe one to be
  interrupted in: a crash between the two leaves the ask with nothing public
  attached.
- It takes an ask id ONLY, like `resolveOwnAuthorship`. It is keyed on the ask's
  `(from_language, to_language, question_normalized)`, NOT on a `ready` panel: a
  `pending` or `failed` run's claim turns public when it settles, and one reader
  can author two rows under one key (a failed attempt then a retry).
- The key is compared RAW. Do not run the ask's language codes through
  `storedLanguage`, whose `de`/`en` fallback would match unrelated rows.
- It is a DELETE, never `listed = false`: afterwards nothing ties the account to
  the question.
- `deleteOwnAuthorshipForKey` keeps `eq(userId)` beside an `inArray` subquery
  over `explanations.id`, so another reader's claim on the same question
  survives.
- `setShowName`/`setListed` carry a second `eq(userId)` clause that
  `resolveOwnAuthorship` makes unreachable through the route, so only a
  DIRECT model call with the wrong id can fail on it.
  `tests/integration/explanation-authorship-setters.test.ts` is that test, and
  deleting either clause turns it red (verified by mutation).

Related: [[the-ask-log-is-the-reader-half-of-explain]],
[[integration-skip-guard-must-be-inline]].
