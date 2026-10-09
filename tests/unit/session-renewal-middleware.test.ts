/**
 * `sessionRenewalMiddleware`, the root middleware that slides the session cookie.
 *
 * WHAT THIS HOLDS IN PLACE
 *   1. A cookie with no `renewedAt` (every cookie minted before renewal existed)
 *      still unseals, the request is served, and the response carries ONE fresh
 *      `_session` cookie with a `Max-Age`.
 *   2. The fresh cookie keeps `issuedAt` exactly as it was. Moving it would let
 *      a cookie minted before a password reset outlive the reset.
 *   3. A cookie renewed under a day ago gets no `Set-Cookie`, so a busy reader
 *      is not sent one with every request. A request with no cookie, or one that
 *      will not unseal, gets none either.
 *   4. A response that already sets `_session` (a sign-in, a sign-out, a
 *      password change) is left alone, because a renewal built from the OLD
 *      request cookie would overwrite the new one.
 *   5. THE MIDDLEWARE NEVER READS THE DATABASE. `#drizzle/db` is replaced by an
 *      object that throws on any access, so a regression fails here and not in
 *      production, where a root middleware that queries would tax every request.
 *   6. A cookie `commitUserSession` has just minted is not renewed by the first
 *      request that carries it.
 *   7. THE WIRING: run through React Router's own static handler, a middleware
 *      on the root route wraps a document-style `query` and a resource
 *      `queryRoute` alike, and `app/root.tsx` exports it.
 *
 * THE SESSION STORAGE IS REAL: the property under test is what ends up in the
 * cookie, and a faked cookie would assert the fake.
 */
import { readFileSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createStaticHandler, RouterContextProvider } from 'react-router';

import { SESSION_MAX_AGE_SECONDS, SESSION_RENEW_AFTER_MS } from '#app/lib/auth/session-renewal';
import type { SessionUser } from '#app/types/session';

let databaseTouches = 0;

/** Any property read or call on the database counts, so reaching for it at all fails the case below. */
mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      databaseTouches += 1;
      return {};
    },
    db: new Proxy(
      {},
      {
        get: () => {
          databaseTouches += 1;
          throw new Error('sessionRenewalMiddleware touched the database');
        },
      },
    ),
  },
});

const { sessionRenewalMiddleware } = await import('#app/middleware/session-renewal');
const { commitUserSession, sessionStorage, SESSION_COOKIE_NAME } = await import('#app/services/session.server');

const ISSUED_AT = '2026-02-01T00:00:00.000Z';

/** A real sealed cookie carrying this user, as the cookie header a browser would send. */
async function cookieHeaderFor(user: SessionUser): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set('user', user);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(';')[0] ?? '';
}

/** Runs the middleware over a request carrying `cookie` (or none), with a downstream answering `answer`. */
async function run(cookie: string | null, answer: Response): Promise<Response> {
  const request = new Request('https://kenning.altan.fyi/', cookie === null ? {} : { headers: { cookie } });
  const result = await sessionRenewalMiddleware(
    { request, url: new URL(request.url), params: {}, pattern: '/', context: new RouterContextProvider() },
    () => Promise.resolve(answer),
  );
  assert.ok(result instanceof Response, 'the middleware did not hand back a response');
  return result;
}

/** The `user` a `Set-Cookie` value would store, read back through the real storage. */
async function userInside(setCookie: string): Promise<SessionUser | undefined> {
  const session = await sessionStorage.getSession(setCookie.split(';')[0]);
  return session.get('user');
}

describe('sessionRenewalMiddleware', () => {
  it('renews a cookie that has no renewedAt, once, with a lifetime', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });

    const response = await run(cookie, new Response('ok'));

    assert.equal(await response.text(), 'ok');
    const renewals = response.headers.getSetCookie();
    assert.equal(renewals.length, 1);
    assert.ok(renewals[0]?.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.match(renewals[0] ?? '', new RegExp(`Max-Age=${SESSION_MAX_AGE_SECONDS}`));
  });

  it('keeps issuedAt exactly as it was and stamps renewedAt', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });

    const response = await run(cookie, new Response('ok'));

    const renewed = await userInside(response.headers.getSetCookie()[0] ?? '');
    assert.equal(renewed?.id, 7);
    assert.equal(renewed?.issuedAt, ISSUED_AT);
    assert.ok(renewed?.renewedAt, 'renewedAt was not stamped');
    assert.ok(Date.now() - new Date(renewed.renewedAt).getTime() < 60_000);
  });

  it('renews a cookie whose last renewal is over a day old', async () => {
    const renewedAt = new Date(Date.now() - SESSION_RENEW_AFTER_MS - 60_000).toISOString();
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT, renewedAt });

    const response = await run(cookie, new Response('ok'));

    assert.equal(response.headers.getSetCookie().length, 1);
  });

  it('sends nothing for a cookie renewed a moment ago', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT, renewedAt: new Date().toISOString() });

    const response = await run(cookie, new Response('ok'));

    assert.deepEqual(response.headers.getSetCookie(), []);
  });

  it('sends nothing to a request with no cookie', async () => {
    const response = await run(null, new Response('ok'));

    assert.deepEqual(response.headers.getSetCookie(), []);
  });

  it('sends nothing for a cookie that will not unseal', async () => {
    const response = await run(`${SESSION_COOKIE_NAME}=not-a-sealed-value`, new Response('ok'));

    assert.deepEqual(response.headers.getSetCookie(), []);
  });

  it('keeps the status, the other headers and the body of the response it renews', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });
    const answer = Response.json({ ok: true }, { status: 201, headers: { 'X-Probe': 'kept' } });

    const response = await run(cookie, answer);

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-probe'), 'kept');
    assert.deepEqual(await response.json(), { ok: true });
  });

  it('renews a redirect too, since a redirect is a finished response', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });

    const response = await run(cookie, new Response(null, { status: 302, headers: { Location: '/welcome' } }));

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/welcome');
    assert.equal(response.headers.getSetCookie().length, 1);
  });

  it('leaves a response alone when it already sets the session cookie itself', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });
    const answer = new Response(null, { status: 204, headers: { 'Set-Cookie': `${SESSION_COOKIE_NAME}=new-value; Path=/` } });

    const response = await run(cookie, answer);

    assert.deepEqual(response.headers.getSetCookie(), [`${SESSION_COOKIE_NAME}=new-value; Path=/`]);
  });

  it('leaves a sign-out alone, since it expires the session cookie', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });
    const answer = new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/` } });

    const response = await run(cookie, answer);

    assert.deepEqual(response.headers.getSetCookie(), [`${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/`]);
  });

  it('still renews when the response sets some other cookie', async () => {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });
    const answer = new Response('ok', { headers: { 'Set-Cookie': 'theme=dark; Path=/' } });

    const response = await run(cookie, answer);

    assert.equal(response.headers.getSetCookie().length, 2);
  });

  it('does not renew the cookie a sign-in has just minted', async () => {
    const minted = await commitUserSession({ request: new Request('https://kenning.altan.fyi/sign-in'), userId: 7 });

    const response = await run(minted.split(';')[0] ?? '', new Response('ok'));

    assert.deepEqual(response.headers.getSetCookie(), []);
  });

  it('never reads the database', async () => {
    assert.equal(databaseTouches, 0);
  });
});

describe('sessionRenewalMiddleware on the root route', () => {
  /** A root route carrying the middleware over one leaf, as `app/root.tsx` does for every route in the app. */
  function buildHandler(leaf: () => Response) {
    return createStaticHandler([
      {
        id: 'root',
        path: '/',
        middleware: [sessionRenewalMiddleware],
        children: [{ id: 'leaf', path: 'leaf', loader: leaf }],
      },
    ]);
  }

  async function requestWithCookie(): Promise<Request> {
    const cookie = await cookieHeaderFor({ id: 7, issuedAt: ISSUED_AT });
    return new Request('https://kenning.altan.fyi/leaf', { headers: { cookie } });
  }

  it('renews a resource route response, the way /api/v1/sync/blob is served', async () => {
    const handler = buildHandler(() => Response.json({ ok: true }));
    const request = await requestWithCookie();

    const result = await handler.queryRoute(request, {
      routeId: 'leaf',
      requestContext: new RouterContextProvider(),
      generateMiddlewareResponse: async (queryRoute) => queryRoute(request),
    });

    assert.ok(result instanceof Response);
    assert.equal(result.headers.getSetCookie().length, 1);
    assert.deepEqual(await result.json(), { ok: true });
  });

  it('renews a document request response, the way / and /?q= are served', async () => {
    const handler = buildHandler(() => Response.json({ ok: true }));
    const request = await requestWithCookie();

    const result = await handler.query(request, {
      requestContext: new RouterContextProvider(),
      generateMiddlewareResponse: async (query) => {
        await query(request);
        return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
      },
    });

    assert.ok(result instanceof Response);
    assert.equal(result.headers.getSetCookie().length, 1);
    assert.equal(await result.text(), '<html></html>');
  });

  it('is exported from app/root.tsx, which is what puts it on every route', () => {
    const source = readFileSync(new URL('../../app/root.tsx', import.meta.url), 'utf8');

    assert.match(source, /export const middleware = \[sessionRenewalMiddleware\];/);
  });
});
