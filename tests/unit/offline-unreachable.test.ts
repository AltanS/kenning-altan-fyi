/**
 * `isServerUnreachable`, the one rule three offline screens share.
 *
 * What is pinned is the BOUNDARY of the rule, because a rule that is too wide
 * hides real faults behind a calm "you are offline" screen:
 *
 *   - a network failure (`TypeError`), a browser that says it is offline, and the
 *     three gateway statuses all count;
 *   - a 401 (the session ended), a 500 (a bug) and a redirect (the server
 *     answering correctly) never count while the browser says it is online.
 *
 * The connectivity flag is passed in, so no case reads `navigator`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isServerUnreachable } from '#app/lib/offline/unreachable';

/** The shape React Router hands a route when a loader threw a `Response`. */
function errorResponse(status: number) {
  return { status, statusText: `status ${status}`, internal: false, data: '' };
}

describe('isServerUnreachable while the browser says it is online', () => {
  it('counts a TypeError, which is how a failed fetch rejects', () => {
    assert.equal(isServerUnreachable(new TypeError('Failed to fetch'), { isOnline: true }), true);
  });

  for (const status of [502, 503, 504]) {
    it(`counts a thrown ${status} ErrorResponse`, () => {
      assert.equal(isServerUnreachable(errorResponse(status), { isOnline: true }), true);
    });

    it(`counts a raw ${status} Response`, () => {
      assert.equal(isServerUnreachable(new Response('', { status }), { isOnline: true }), true);
    });
  }

  for (const status of [400, 401, 403, 404, 500, 501]) {
    it(`does not count a ${status} ErrorResponse`, () => {
      assert.equal(isServerUnreachable(errorResponse(status), { isOnline: true }), false);
    });
  }

  it('does not count a redirect Response', () => {
    const redirect = new Response(null, { status: 302, headers: { location: '/sign-in' } });
    assert.equal(isServerUnreachable(redirect, { isOnline: true }), false);
  });

  it('does not count an ordinary Error, which is a bug and must reach the boundary', () => {
    assert.equal(isServerUnreachable(new Error('boom'), { isOnline: true }), false);
  });

  it('does not count a value that is not an error at all', () => {
    for (const cause of [undefined, null, 'offline', 503, { status: 503 }]) {
      assert.equal(isServerUnreachable(cause, { isOnline: true }), false, `read ${String(cause)} as unreachable`);
    }
  });
});

describe('isServerUnreachable while the browser says it is offline', () => {
  it('counts anything, because the connection is the reason', () => {
    for (const cause of [new Error('boom'), errorResponse(401), errorResponse(500), undefined]) {
      assert.equal(isServerUnreachable(cause, { isOnline: false }), true);
    }
  });
});

describe('isServerUnreachable with no connectivity flag given', () => {
  it('reads Node, which has no navigator.onLine, as online', () => {
    assert.equal(isServerUnreachable(new Error('boom')), false);
    assert.equal(isServerUnreachable(new TypeError('Failed to fetch')), true);
  });
});
