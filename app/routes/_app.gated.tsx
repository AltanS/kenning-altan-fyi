import { Outlet } from 'react-router';
import { authMiddleware } from '#app/middleware/auth';

/**
 * The half of the app shell that requires an account (M184, ADR-0009).
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY THE MIDDLEWARE IS NOT ON `_app.tsx`.
 *   Middleware is exported per MODULE and applies to every route matched under
 *   it, so a `middleware` export on `_app.tsx` would gate everything inside the
 *   shell, `/` included. That was M184's hard requirement, because `/` was
 *   then the landing page and a signed-out stranger had to get a 200 there
 *   with a real worked example. M199 moved the landing page to `/welcome`, and
 *   the reason this file still exists is the plainer one underneath: `/`,
 *   `/account`, `/sign-out` and `/offline` each have to answer a caller with
 *   no session, for four different reasons, so the gated routes get a pathless
 *   layout of their own and those four stay beside it. The nesting is the
 *   classification: a route file inside this block is gated because of where
 *   it sits, not because a list somewhere says so.
 *
 *   REJECTED: one middleware on `_app.tsx` that reads the request path and
 *   waives itself for the public ones. That is a path-keyed rule, and this
 *   milestone exists because a path-keyed rule gated `/search` (now `/translate`) while leaving
 *   `/?q=` wide open. A rule keyed on the shape of the request belongs in the
 *   loader that reads that shape, which is where `translate.tsx` now carries it.
 *
 * WHAT IS NOT IN HERE, DELIBERATELY. `/`, `/account`, `/sign-out` and
 * `/offline` stay outside. `/` is the one that matters: it is gated, by the
 * request-keyed rule at the top of `routes/translate.tsx`'s loader, and it
 * cannot be gated from HERE, because a route sits in exactly one layout and
 * the index has to keep the app shell for the reader who is signed in.
 * `/account` reports the signed-out state rather than ending it, `/sign-out`
 * has to work from a broken state, and `/offline` must render with no network
 * at all, which is not a state in which a session can be resolved.
 *
 * `/translate` AND `/explain` CAME IN HERE IN M199. Both were public with a
 * request-keyed rule of their own until then, on the argument that their
 * empty-`q` state was a landing screen a stranger could read. `/welcome` is
 * that screen now, one card in the `_public` layout, so neither has a public
 * half left to preserve. `/translate` is the ALIAS only: the index above is
 * the same module and is still gated by its loader, so deleting that rule and
 * trusting this layout would reopen `/?q=`.
 *
 * IT RENDERS NOTHING OF ITS OWN. `AppWrapper` is already around it, one level
 * up, so a second chrome here would be a frame inside a frame.
 *
 * IT TOUCHES NO LOCAL DATA. The gate blocks the SCREEN, never the device's own
 * store: a visitor's lists and history are theirs, they were never uploaded,
 * and a redirect must not be the thing that deletes them.
 */
export const middleware = [authMiddleware];

export default function GatedAppLayout() {
  return <Outlet />;
}
