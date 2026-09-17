---
name: welcome-is-the-front-door-m199
description: M199 moved the signed-out visitor off `/` onto `/welcome`; `/translate` and `/explain` went under `_app.gated`, but the index cannot follow and keeps its loader rule
metadata:
  type: project
---

`/welcome` (`app/routes/welcome.tsx`, `_public` layout) is the only screen a
visitor with no account sees. `/translate` and `/explain` sit under
`_app.gated.tsx`; the INDEX does not and cannot, so the request-keyed rule at
the top of `app/routes/translate.tsx`'s loader is still the only thing gating
`/`: empty `q` throws `redirect(WELCOME_PATH)`, any other `q` throws the
`/sign-in?next=` redirect.

**Why:** a route sits in exactly ONE layout, and `/` has to keep the app shell
for the signed-in reader. Before M199 a stranger at `/`, `/translate` or
`/explain` got the whole shell, sidebar, language bar, input card, mode switch,
and every control refused them.

**How to apply:** never delete the loader rule because the alias is gated by a
layout, that reopens `/?q=` (the M184 hole). `tests/unit/gated-app-surface.test.ts`
walks the real route config and greps the loader source for exactly that.
`WELCOME_PATH` lives in `app/lib/auth/paths.ts`, which has no server imports,
because a route COMPONENT reads it. See [[route-classification-after-m199]].
