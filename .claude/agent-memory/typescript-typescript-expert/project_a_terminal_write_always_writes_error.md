---
name: project-a-terminal-write-always-writes-error
description: pg-boss retries a timed-out job on the SAME run row, so a settle that only writes error when given one leaves the last attempt's message beside a good answer
metadata:
  type: project
---

All three run ledgers settle with `error: params.error ?? null`, never with a
conditional spread: `explanationTerminalValues` in
`app/models/explanations.server.ts`, `finishPhrase` in `phrase-runs.server.ts`
and `finishRun` in `translation-runs.server.ts`.

**Why:** pg-boss retries a timed-out job with the same `runId`, so attempt one
writes `failed` + a timeout message and the retry writes `ok` + an answer onto
the same row. While `error` was written only when passed, the timeout survived
the success. Dev row `73d9fe0f-3bf1-4752-a0e3-0dacc557e8cc` is `status='ok'`
with a full answer and `Request timed out after 90019ms`. No reader screen
shows it; every operator surface reading the column reports a failure that did
not happen.

**How to apply:** a terminal write describes how THIS attempt ended, so every
column that describes the ending is written on every path. The other
conditional spreads in those `set()` calls are correct and stay: an absent key
leaves a column alone, which is what a refused run wants for `answer` and
`latencyMs`. `explanationTerminalValues` is pure and exported so the shape is
asserted with no database (`tests/unit/explanation-settle-values.test.ts`).
