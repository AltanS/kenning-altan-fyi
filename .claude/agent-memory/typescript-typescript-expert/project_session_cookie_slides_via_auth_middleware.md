---
name: session-cookie-slides-via-root-middleware
description: kenning _session cookie (400-day maxAge) is renewed by the ROOT route's sessionRenewalMiddleware, not authMiddleware; it reads no DB
metadata:
  type: project
---

`sessionRenewalMiddleware` (`app/middleware/session-renewal.ts`) is exported from `app/root.tsx` as `middleware`. In RR 8.3 `staticHandler.query` and `queryRoute` both run the middleware of EVERY match, root first, so it covers documents, `.data` single fetch and `/api/*` resource routes. `next()` hands back a finished Response in all three.

**Why:** the first version lived in `authMiddleware` and missed `/`, `/?q=`, the PWA `start_url` and `/api/v1/sync/blob` (which calls `resolveUser` inline). A reader who used only those was signed out 400 days after sign-in.

**How to apply:** the middleware reads only the sealed cookie (`readUserSession`, `shouldRenewSession`), never the DB; a unit test mocks `#drizzle/db` with a throwing Proxy to hold that. It skips any response that already sets `_session` (sign-in, sign-out, password change, `authMiddleware`'s `refuse()`). `commitUserSession` stamps `renewedAt = issuedAt`. `authMiddleware` no longer imports `renewUserSession` or `SESSION_COOKIE_NAME`, so `enrichment-request-route.test.ts`'s `session.server` mock needs no extra names. Accepted race: no session table, so a stale renewal after a sign-out in another tab can restore the cookie, at most once a day per device.
