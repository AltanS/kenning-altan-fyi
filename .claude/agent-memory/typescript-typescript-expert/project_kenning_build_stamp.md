---
name: kenning-build-stamp
description: The build stamp is __KENNING_BUILD__ via Vite define plus build/build-info.json, one object parked on globalThis across the two build passes
metadata:
  type: project
---

`vite.config.ts` computes `{ version, sha, builtAt }` ONCE and ships it two
ways: `define` replaces the bare identifier `__KENNING_BUILD__` in the client
and SSR bundles (`app/lib/build-info.ts` reads it inside a `try`, because an
undeclared identifier throws `ReferenceError`), and a `closeBundle` plugin
writes `build/build-info.json` beside the bundle. `KENNING_BUILD_SHA` overrides
the sha, `git rev-parse --short HEAD` is the fallback, `unknown` is the floor.
Ambient types in `types/build-info.d.ts`.

**Why:** `react-router build` runs a client pass AND an SSR pass and
re-evaluates `vite.config.ts` for each, in one process. Computing the stamp per
evaluation gives the two bundles two different `builtAt` values and the JSON a
third, so the first pass parks its answer on `globalThis.__kenningBuildStamp`
and the second reuses it. The same object carries the write-once flag, because
`closeBundle` also fires per pass.

**How to apply:** never add a second place that derives version or sha. The
Docker image carries no git, so a deployed build that nobody passed
`KENNING_BUILD_SHA` stamps `unknown`, which makes the update ribbon silent and
`formatBuildLabel` drop the sha half. That is the designed degradation, not a
bug: an unstamped build must be obviously unstamped, never plausibly wrong.
Related: [[kenning-api-build-endpoint]].
