/**
 * The root middleware that keeps the session cookie sliding.
 *
 * IT RUNS ON EVERY MATCHED REQUEST, because `app/root.tsx` exports it and every
 * route has the root as its ancestor: a page, a `.data` single-fetch, and a
 * resource route under `/api/` alike (React Router's `staticHandler.query` and
 * `queryRoute` both run the middleware of every match, root first). That is the
 * point of putting it here and not in `authMiddleware`: `/`, `/?q=`, the PWA
 * `start_url`, and `/api/v1/sync/blob`, which resolves its user inline, sit
 * outside that gate, and a reader who only ever used those was signed out 400
 * days after signing in.
 *
 * IT NEVER READS THE DATABASE. It opens the sealed cookie, asks
 * {@link shouldRenewSession}, and after the route has answered it appends a
 * fresh `Set-Cookie`. Nothing here decides who may do what, so there is nothing
 * to look up. That is safe because renewal moves `renewedAt` and never
 * `issuedAt`: a cookie the password epoch refuses (`authMiddleware`,
 * `resolveUser`) is refused after it is renewed exactly as before.
 *
 * IT LEAVES A RESPONSE ALONE THAT ALREADY SETS `_session`. A sign-in, a
 * sign-out, a password change and `authMiddleware`'s own refusal all write the
 * cookie themselves, and a renewal built from the OLD request cookie would
 * overwrite what they wrote.
 *
 * AN ACCEPTED RACE. There is no server-side session table, so a renewal built
 * from the old request cookie that arrives after the reader signed out in
 * another tab can restore that cookie. The window is at most once a day per
 * device, since a cookie renewed inside the last day is never renewed again.
 */
import type { MiddlewareFunction } from 'react-router';

import { shouldRenewSession } from '#app/lib/auth/session-renewal';
import { readUserSession, renewUserSession, SESSION_COOKIE_NAME } from '#app/services/session.server';

export const sessionRenewalMiddleware: MiddlewareFunction = async ({ request }, next) => {
  const session = await readUserSession(request);
  if (session === null || !shouldRenewSession(session, new Date())) return next();

  const response = await next();
  // On the server `next()` always resolves to a `Response`; the guard is what
  // lets the rest of this function treat it as one.
  if (!(response instanceof Response)) return response;
  if (setsSessionCookie(response)) return response;

  const setCookie = await renewUserSession({ request, now: new Date() });
  if (setCookie === null) return response;

  // A fresh `Response` rather than a write to `response.headers`: a response a
  // route got from `fetch` has immutable headers, and a throw here would turn a
  // finished request into a 500.
  const renewed = new Response(response.body, response);
  renewed.headers.append('Set-Cookie', setCookie);
  return renewed;
};

/** Whether the response already carries its own `_session` cookie, which renewal must not overwrite. */
function setsSessionCookie(response: Response): boolean {
  return response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
}
