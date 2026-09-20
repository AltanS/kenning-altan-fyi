---
name: a-queued-rerun-supersedes-the-run-it-judged
description: enqueueTranslation opens a NEW pending run under the same key, so latestRun stops reporting `ok` the instant a rejection orders a re-run; a second press then correctly answers no-run
metadata:
  type: project
---

The reject route finds the answer being complained about with
`latestRun(db, { headwordId, from, to })` and demands `status === 'ok'`. A
rejection that ORDERS a re-run opens a new `pending` row under that same key, so
from that moment `latestRun` returns the pending row and the next press answers
`no-run`.

**Why:** that is correct, not a defect. While the re-run is in flight the pane reads
`translating`, there is no answer on screen, and there is nothing to reject. Do NOT
loosen the guard to "the latest OK run": a rejection must point at a real model
answer or the fine-tuning corpus fills with rows naming no output.

**How to apply:** a test for a repeat press, or for a second reader on one run, cannot
reuse the pair whose re-run was just queued. Drive it against a pair whose re-run was
WITHHELD, by stamping `touchRetranslationCooldown` on it in `before()`; its latest run
then stays `ok` for the whole file. `tests/integration/translation-rejection.test.ts`
is built that way and carries a case asserting the two-run state explicitly, so the
reason the second pair exists cannot be refactored away in ignorance.

Related: [[project_reject_route_is_the_only_rerun_caller]]
