---
name: explain-is-the-third-sibling-m198
description: Kenning's Explain mode copies the phrase pipeline file for file, but takes its own panel union, its own queue and its own refusal copy
metadata:
  type: project
---

Explain (M198) is the THIRD sibling of the translation pipeline, after the word
path (M193) and the phrase path (M195). It mirrors `phrase-*` one for one, with
three deliberate divergences.

**Why:** the phrase path answers `TranslationPanel` so a reader cannot tell which
branch answered them, and it rides the `translation` queue. Neither holds here: an
explanation is a five-part document on a different screen, and an explain call is
the slowest this app makes.

**How to apply:**
- `ExplainPanel` is its OWN union in `app/lib/translation/explain-panel.server.ts`.
  Same six states, `TranslationRefusal` reused outright, but `ready` carries
  `{ answer: Explanation, explanationId, model }`. Do not force it into a
  `TranslationRow`.
- `EXPLAIN_QUEUE = 'explain-terms'` is its own pg-boss queue with one worker. A new
  queue is dead unless it is in THREE places: the `queues` list AND the
  `createQueue`/`updateQueue` pair, both in `app/services/workflows.server.ts`, and
  the template's `queue` field. See [[pgboss-queue-policy-dedupe]].
- The refusal copy is `explain.*`, not the translator's. Two of the four sentences
  would be untrue if shared: `too-long` names the cap (300 here, 200 there) and the
  budget line names what ran out.
- The guard order is the phrase order, proved by call log in
  `tests/unit/explain-panel-gate.test.ts`: length cap, rate limit, day cap, budget.
- `/explain` classifies as `landing-loader-split`, which is no longer
  "`translate.tsx` and only `translate.tsx`".
