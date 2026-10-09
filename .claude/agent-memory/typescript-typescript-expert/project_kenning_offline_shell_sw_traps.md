---
name: project-kenning-offline-shell-sw-traps
description: kenning offline shell (public/sw.js + scripts/build-precache.ts) - a stamp placeholder contract, a kill worker that must NOT unregister, and the text-scan test that pins sw.js
metadata:
  type: project
---

`public/sw.js` holds the literal `'__PRECACHE_STAMP__'` (quoted) exactly once; `scripts/build-precache.ts` swaps it after `react-router build` and throws otherwise. Never write that quoted literal in a sw.js comment.

**Why:** the build step splits on the quoted form and demands exactly two parts, so a comment copy fails the build.

A kill worker (docs/sw-kill.js) must not unregister itself: `registerServiceWorker` runs `register('/sw.js')` on every load, so unregister + navigate reinstalls and reloads forever.

`tests/unit/service-worker-exclusions.test.ts` scans sw.js TEXT (needles `isUncacheable(url)`, `AUTH_PATHS.has(url.pathname)`, `APP_SHELL`) and runs `isUncacheable` in a vm. The precache redesign removed `APP_SHELL`, so its "precaches every app shell route" case needs a rewrite, not a fix to sw.js.

oxlint traps hit here: `promise/param-names` (a Promise executor with an unused `resolve` cannot be renamed `_`, so resolve a sentinel instead), `jsx-a11y/prefer-tag-over-role` (use `<output>` for `role="status"`), `no-shadow` on an imported `resolve`, and `no-control-regex` (test char codes in a loop instead of a regex).

How to apply: when touching sw.js, rerun that test file first. Related: [[project_root_clientloader_offline_revalidation]].
