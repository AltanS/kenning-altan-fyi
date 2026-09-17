---
name: kenning-api-build-endpoint
description: GET /api/build is public and no-store, and its answer is derived LIVE in dev and read from the stamp file in production
metadata:
  type: project
---

`app/routes/api.build.ts` answers `{ version, sha, builtAt }` from
`SERVER_BUILD` in `app/lib/build-info.server.ts`. `selectServerBuild` reads
`build/build-info.json` ONLY in production and derives the answer live
(package.json + git) in development.

**Why:** in dev the browser's stamp comes from Vite, computed when the dev
server starts, while an earlier `pnpm build` may have left a
`build/build-info.json` from a different commit. Read the file in dev and the
two disagree permanently: `observeServerBuild` sees two known unequal shas on
every poll and the ribbon offers a reload for the rest of the session, on a
page that is already the newest there is. Reloading cannot clear it.

**How to apply:** the route is classified `public` in
`app/lib/route-classification.ts` and must stay ungated, because a signed-out
reader's page goes stale too. Keep the `no-store` headers: a cached answer
reports the build the reader was first served, forever. `public/sw.js` already
leaves every `/api/` path uncached. Related: [[kenning-build-stamp]].
