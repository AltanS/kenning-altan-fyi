/**
 * What the page does when a sync request is refused because of WHO is asking.
 *
 * A 401 (the session ended) and a 412 (another account is signed in) both
 * pause sync: the in-memory session goes, the hint gains a pause with the
 * reason, and NOTHING is deleted. Everything else is not this module's business
 * and must come back `false` so the caller reports or retries it as before.
 *
 * `pauseSyncOnAuthFailure` reads the browser's `localStorage` through the
 * hint module's default, so each case installs an in-memory one on
 * `globalThis` and removes it afterwards.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SIGNED_IN_HINT_KEY, readSignedInHint, replaceSignedInHint } from '#app/lib/auth/signed-in-hint';
import { pauseSyncOnAuthFailure } from '#app/lib/sync/session-pause';
import { SyncRequestError, type SyncErrorKind } from '#app/lib/sync/sync-error';
import { clearSyncSession, getSyncSession, setSyncSession } from '#app/lib/sync/sync-session';

/** Installs an in-memory `localStorage` and returns the map behind it. */
function installLocalStorage(): Map<string, string> {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  return values;
}

function refusal(kind: SyncErrorKind, status: number | null): SyncRequestError {
  return new SyncRequestError({ kind, message: `a ${kind} refusal`, status });
}

describe('pauseSyncOnAuthFailure', () => {
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = installLocalStorage();
    replaceSignedInHint(7);
    setSyncSession({ userId: 7 });
  });

  afterEach(() => {
    clearSyncSession();
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('pauses as expired on a 401, drops the session and keeps the hint', () => {
    assert.equal(pauseSyncOnAuthFailure(refusal('unauthorized', 401)), true);
    assert.equal(getSyncSession(), null);
    const hint = readSignedInHint();
    assert.equal(hint?.userId, 7, 'the hint must survive a 401: the data on the device is still this account');
    assert.equal(hint?.pause?.reason, 'expired');
  });

  it('keeps an other-account pause when a 401 arrives on top of it', () => {
    stored.set(SIGNED_IN_HINT_KEY, JSON.stringify({ userId: 7, pause: { reason: 'other-account', at: 55 } }));
    assert.equal(pauseSyncOnAuthFailure(refusal('unauthorized', 401)), true);
    assert.deepEqual(readSignedInHint(), { userId: 7, pause: { reason: 'other-account', at: 55 } });
    assert.equal(getSyncSession(), null);
  });

  it('pauses as other-account on a 412 and drops the session', () => {
    assert.equal(pauseSyncOnAuthFailure(refusal('account-mismatch', 412)), true);
    assert.equal(getSyncSession(), null);
    assert.equal(readSignedInHint()?.pause?.reason, 'other-account');
    assert.equal(readSignedInHint()?.userId, 7);
  });

  it('lets a 412 upgrade an expired pause', () => {
    stored.set(SIGNED_IN_HINT_KEY, JSON.stringify({ userId: 7, pause: { reason: 'expired', at: 55 } }));
    assert.equal(pauseSyncOnAuthFailure(refusal('account-mismatch', 412)), true);
    assert.deepEqual(readSignedInHint(), { userId: 7, pause: { reason: 'other-account', at: 55 } });
  });

  it('ignores a transport failure: the session and the hint stay as they were', () => {
    assert.equal(pauseSyncOnAuthFailure(refusal('transport', null)), false);
    assert.deepEqual(getSyncSession(), { userId: 7 });
    assert.deepEqual(readSignedInHint(), { userId: 7 });
  });

  it('ignores a server error, a throttle and a size refusal', () => {
    for (const [kind, status] of [['server', 500], ['throttled', 429], ['too-large', 413], ['forbidden', 403]] as const) {
      assert.equal(pauseSyncOnAuthFailure(refusal(kind, status)), false, kind);
    }
    assert.deepEqual(readSignedInHint(), { userId: 7 });
  });

  it('ignores something that is not a sync error at all', () => {
    assert.equal(pauseSyncOnAuthFailure(new TypeError('Failed to fetch')), false);
    assert.equal(pauseSyncOnAuthFailure('boom'), false);
    assert.deepEqual(getSyncSession(), { userId: 7 });
  });

  it('with no hint it still drops the session and writes nothing', () => {
    stored.clear();
    assert.equal(pauseSyncOnAuthFailure(refusal('unauthorized', 401)), true);
    assert.equal(getSyncSession(), null);
    assert.equal(stored.size, 0, 'a 401 must not invent a hint out of nothing');
  });
});
