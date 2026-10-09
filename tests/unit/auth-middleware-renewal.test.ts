/**
 * `authMiddleware` no longer renews the session cookie.
 *
 * Renewal moved to the root route's `sessionRenewalMiddleware`
 * (`tests/unit/session-renewal-middleware.test.ts`), because a renewal inside
 * the gate missed every route outside it. If both ran, a gated request would be
 * renewed twice, so this file holds the gate to its one job.
 *
 * WHAT THIS HOLDS IN PLACE
 *   1. A signed-in request through `authMiddleware` gets no `Set-Cookie`, even
 *      with a cookie that would be due for renewal.
 *   2. The user is still set in context, so the gate still gates.
 *   3. A refusal still destroys the cookie: `authMiddleware` keeps writing
 *      `_session` itself, which is why the renewal middleware skips it.
 *
 * THE SESSION STORAGE IS REAL, the user row is faked.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import type { SessionUser } from '#app/types/session';

const USER_ROW = {
  id: 7,
  email: 'reader@example.test',
  isSuperadmin: false,
  emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  passwordChangedAt: new Date('2026-01-01T00:00:00.000Z'),
};

mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => ({}),
    db: { query: { users: { findFirst: () => Promise.resolve(USER_ROW) } } },
  },
});

const { authMiddleware } = await import('#app/middleware/auth');
const { userContext } = await import('#app/middleware/context');
const { sessionStorage, SESSION_COOKIE_NAME } = await import('#app/services/session.server');

const ISSUED_AT = '2026-02-01T00:00:00.000Z';

/** A real sealed cookie carrying this user, as the cookie header a browser would send. */
async function cookieHeaderFor(user: SessionUser): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set('user', user);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(';')[0] ?? '';
}

describe('authMiddleware', () => {
  it('sets the user and appends no Set-Cookie, even for a cookie due for renewal', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });
    const request = new Request('https://kenning.altan.fyi/translate', { headers: { cookie } });
    const context = new RouterContextProvider();

    // The gate is called the way React Router calls it: with the args, and a `next` it must not need.
    const result = await authMiddleware(
      { request, url: new URL(request.url), params: {}, pattern: '/translate', context },
      () => Promise.reject(new Error('authMiddleware must not call next')),
    );

    assert.equal(result, undefined);
    assert.equal(context.get(userContext)?.id, 7);
  });

  it('refuses a request with no cookie, and the refusal sets the session cookie itself', async () => {
    const request = new Request('https://kenning.altan.fyi/translate');

    await assert.rejects(
      Promise.resolve(
        authMiddleware(
          { request, url: new URL(request.url), params: {}, pattern: '/translate', context: new RouterContextProvider() },
          () => Promise.resolve(new Response('unreachable')),
        ),
      ),
      (thrown) => {
        assert.ok(thrown instanceof Response);
        assert.equal(thrown.status, 302);
        assert.ok(thrown.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`)));
        return true;
      },
    );
  });
});
