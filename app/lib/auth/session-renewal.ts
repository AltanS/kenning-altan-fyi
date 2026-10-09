/**
 * session-renewal.ts, how long the session cookie lives and when it is renewed.
 *
 * PURE, AND FREE OF THE FRAMEWORK, so a unit test can reach it without a
 * database or the session secret. `app/services/session.server.ts` reads the
 * lifetime; `app/middleware/session-renewal.ts` asks {@link shouldRenewSession}.
 */
import type { SessionUser } from '#app/types/session';

/**
 * How long a session cookie lives, in seconds: 400 days.
 *
 * 400 DAYS IS CHROME'S CAP on a cookie's lifetime. A longer value is not
 * honoured, the browser clamps it, so asking for more buys nothing. Without
 * any `maxAge` the cookie is a browser-session cookie, and a browser restart
 * signs the reader out.
 *
 * THE LIFETIME SLIDES. Any request that finds the cookie older
 * than {@link SESSION_RENEW_AFTER_MS} sends a fresh one, so a reader who uses
 * the app never reaches the end of it. Only an idle reader does.
 */
export const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** How old the last renewal may be before the next request renews again: 24 hours. It keeps a busy reader from getting a `Set-Cookie` on every request. */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether this request should hand the browser a fresh cookie.
 *
 * AN OLD COOKIE RENEWS ONCE. A cookie minted before `renewedAt` existed has no
 * such field, and a field that is missing or will not parse is treated as
 * "never renewed". Both cost one `Set-Cookie`, after which the field is there.
 * Renewing too eagerly is harmless; renewing too rarely signs a reader out.
 *
 * @param session the user the cookie carries.
 * @param now the current instant.
 * @returns `true` when the cookie should be re-issued.
 */
export function shouldRenewSession(session: SessionUser, now: Date): boolean {
  if (session.renewedAt === undefined) return true;

  const renewedAtMs = new Date(session.renewedAt).getTime();
  if (Number.isNaN(renewedAtMs)) return true;

  return now.getTime() - renewedAtMs >= SESSION_RENEW_AFTER_MS;
}
