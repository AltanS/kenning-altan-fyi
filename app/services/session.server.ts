/**
 * The browser session cookie: who is signed in, and since when.
 *
 * WHY A COOKIE AND NOT A BEARER TOKEN. The client here is a browser on the same
 * origin as the server, so there is no cross-origin request to make and nothing
 * to gain from a credential JavaScript can read. An httpOnly cookie cannot be
 * exfiltrated by injected script; a token in `localStorage` can. `sameSite:
 * 'lax'` plus React Router's own same-origin check is what replaces the CSRF
 * property a header-only credential would give, and `TRUST_PROXY` is set so the
 * framework sees the browser's origin through Traefik rather than the proxy's.
 *
 * WHAT IS STORED. The user id, the issue instant and the last renewal instant,
 * and nothing else. No password, no token, no email: the middleware re-reads
 * the row on every request, so a stale cookie cannot outlive the user it names.
 *
 * HOW LONG IT LIVES. 400 days, `SESSION_MAX_AGE_SECONDS`, and the lifetime
 * SLIDES: `sessionRenewalMiddleware` (`app/middleware/session-renewal.ts`, the
 * root route's middleware, so it covers every request) re-issues the cookie
 * through {@link renewUserSession} when the last renewal is more than a day old,
 * so a reader who keeps using the app is never signed out by the clock. Without
 * a `maxAge` the cookie would be a browser-session cookie, and every browser
 * restart would sign the reader out. Renewal moves `renewedAt` and never
 * `issuedAt`, which the password epoch measures against.
 */
import { createCookieSessionStorage } from 'react-router';

import { CONFIG } from '#app/config';
import { SESSION_MAX_AGE_SECONDS } from '#app/lib/auth/session-renewal';
import type { SessionData, SessionUser } from '#app/types/session';

/** The cookie's name, exported so a caller can tell whether a response already sets it. */
export const SESSION_COOKIE_NAME = '_session';

/** Typed with `SessionData`, so `session.get('user')` returns a `SessionUser` rather than a value every caller asserts. */
export const sessionStorage = createCookieSessionStorage<SessionData>({
  cookie: {
    name: SESSION_COOKIE_NAME,
    sameSite: 'lax',
    path: '/',
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    secrets: [CONFIG.session.secret],
    secure: CONFIG.app.isProduction,
  },
});

export const { getSession, commitSession, destroySession } = sessionStorage;

/**
 * The `Set-Cookie` value that signs a user in.
 *
 * TAKES THE REQUEST RATHER THAN A `Session`, deliberately: a caller holding a
 * session it read earlier in the same handler would commit a snapshot and
 * silently drop whatever another line of that handler wrote.
 *
 * @param input.request the incoming request, read for its existing cookie.
 * @param input.userId the user this browser is now signed in as.
 * @param input.issuedAt when the session starts. Defaults to now.
 * @returns a `Set-Cookie` header value.
 */
export async function commitUserSession(input: {
  request: Request;
  userId: number;
  issuedAt?: Date;
}): Promise<string> {
  const session = await sessionStorage.getSession(input.request.headers.get('cookie'));
  // `renewedAt` starts equal to `issuedAt`: a cookie just minted is fresh, and
  // without the field the first request after sign-in would renew it again.
  const issuedAt = (input.issuedAt ?? new Date()).toISOString();
  session.set('user', { id: input.userId, issuedAt, renewedAt: issuedAt });
  return sessionStorage.commitSession(session);
}

/**
 * The `Set-Cookie` value that extends a session's lifetime.
 *
 * `issuedAt` IS COPIED THROUGH UNCHANGED. It is the session's age as the
 * password epoch sees it, so moving it forward would let a cookie minted before
 * a password reset outlive the reset. Only `renewedAt` moves.
 *
 * @param input.request the incoming request, read for its existing cookie.
 * @param input.now the renewal instant.
 * @returns a `Set-Cookie` header value, or `null` when the cookie carries no user.
 */
export async function renewUserSession(input: { request: Request; now: Date }): Promise<string | null> {
  const session = await sessionStorage.getSession(input.request.headers.get('cookie'));
  const user = session.get('user');
  if (user === undefined) return null;

  session.set('user', { ...user, renewedAt: input.now.toISOString() });
  return sessionStorage.commitSession(session);
}

/**
 * The `Set-Cookie` value that signs the caller out.
 *
 * DESTROYS THE WHOLE COOKIE rather than deleting the `user` key: a sign-out on
 * a shared device should leave nothing behind, and every other key this cookie
 * carries is a preference that costs nothing to rebuild.
 *
 * @param request the incoming request.
 * @returns a `Set-Cookie` header value that expires the cookie.
 */
export async function destroyUserSession(request: Request): Promise<string> {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  return sessionStorage.destroySession(session);
}

/**
 * The `user` key, or `null` for anything unusable.
 *
 * IT NEVER THROWS. `getSession` REJECTS on a cookie it cannot unseal, and every
 * caller treats that as signed out: the usual causes are a rotated
 * `SESSION_SECRET` and a truncated cookie, and both should render a signed-out
 * page rather than a 500.
 *
 * @param request the incoming request, read only for its cookie header.
 * @returns the stored user, or `null`.
 */
export async function readUserSession(request: Request): Promise<SessionUser | null> {
  try {
    const session = await sessionStorage.getSession(request.headers.get('cookie'));
    return session.get('user') ?? null;
  } catch {
    return null;
  }
}
