/**
 * What `/sign-out` does to the device, by whose data the device holds.
 *
 * The normal branch is unchanged: one last sync, then the session and the hint
 * go and both databases are wiped. The `other-account` branch is the new one.
 * There the stored data is NOT the signing-out account's: syncing it would push
 * one account's lists into another's document, and wiping it would destroy lists
 * the other account never synced. So that branch skips both, keeps the hint, sets
 * the pause to `expired`, and still runs the server action so the cookie goes.
 *
 * The order matters in both branches and is asserted: the server action is LAST
 * because it throws the redirect, and nothing after it runs.
 */
import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { SyncRequestError } from '#app/lib/sync/sync-error';

/** What happened, in order. */
let events: string[] = [];

/** What the stub final sync does besides recording itself. Reset before each test. */
let onFinalSync: () => void = () => {};

mock.module('#app/lib/local-store', {
  namedExports: {
    wipeDeviceStore: () => {
      events.push('wipe');
      return Promise.resolve(['translate-primary', 'translate-outbox']);
    },
  },
});
mock.module('#app/components/account/sync-client', {
  namedExports: {
    syncNow: () => {
      events.push('final-sync');
      onFinalSync();
      return Promise.resolve(null);
    },
  },
});
mock.module('#app/services/session.server', {
  namedExports: { destroyUserSession: () => Promise.resolve('cookie=') },
});
mock.module('#app/lib/report-error', {
  namedExports: { reportError: () => events.push('report') },
});

const { clientAction } = await import('#app/routes/sign-out');
const { SIGNED_IN_HINT_KEY, readSignedInHint } = await import('#app/lib/auth/signed-in-hint');
const { getSyncSession, setSyncSession } = await import('#app/lib/sync/sync-session');
const { pauseSyncOnAuthFailure } = await import('#app/lib/sync/session-pause');

/** The map behind the stub `localStorage`. */
let stored = new Map<string, string>();

function runClientAction(): Promise<Response> {
  // SAFETY: `clientAction` reads only `serverAction` from its args.
  return clientAction({
    serverAction: () => {
      events.push('server-action');
      return Promise.resolve(new Response(null, { status: 302 }));
    },
  } as never);
}

beforeEach(() => {
  events = [];
  onFinalSync = () => {};
  stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
  setSyncSession({ userId: 3 });
});

describe('signing out of a device that holds ANOTHER account', () => {
  beforeEach(() => {
    stored.set(SIGNED_IN_HINT_KEY, JSON.stringify({ userId: 3, pause: { reason: 'other-account', at: 10 } }));
  });

  it('skips the final sync and the wipe, and runs only the server action', async () => {
    await runClientAction();
    assert.deepEqual(events, ['server-action']);
  });

  it('keeps the hint, naming the account whose data is still here, and records expired', async () => {
    await runClientAction();
    const hint = readSignedInHint();
    assert.equal(hint?.userId, 3);
    assert.equal(hint?.pause?.reason, 'expired');
  });

  it('drops the in-memory session so nothing syncs mid-redirect', async () => {
    await runClientAction();
    assert.equal(getSyncSession(), null);
  });
});

describe('signing out of a device that holds the signing-out account', () => {
  it('syncs once, wipes both databases, clears the hint, and runs the server action last', async () => {
    stored.set(SIGNED_IN_HINT_KEY, JSON.stringify({ userId: 3 }));
    await runClientAction();
    assert.deepEqual(events, ['final-sync', 'wipe', 'server-action']);
    assert.equal(readSignedInHint(), null);
    assert.equal(stored.has(SIGNED_IN_HINT_KEY), false);
    assert.equal(getSyncSession(), null);
  });

  it('does the same for an expired pause: the data is this account\'s own', async () => {
    stored.set(SIGNED_IN_HINT_KEY, JSON.stringify({ userId: 3, pause: { reason: 'expired', at: 10 } }));
    await runClientAction();
    assert.deepEqual(events, ['final-sync', 'wipe', 'server-action']);
    assert.equal(readSignedInHint(), null);
  });

  it('does the same when there is no hint at all', async () => {
    await runClientAction();
    assert.deepEqual(events, ['final-sync', 'wipe', 'server-action']);
  });
});

describe('signing out when only the final sync finds the cookie is another account\'s', () => {
  beforeEach(() => {
    // The hint carries no pause yet. The real sync client answers a 412 by
    // pausing sync (`pauseSyncOnAuthFailure`) and then rethrowing.
    stored.set(SIGNED_IN_HINT_KEY, JSON.stringify({ userId: 3 }));
    onFinalSync = () => {
      const refusal = new SyncRequestError({ kind: 'account-mismatch', message: 'account mismatch', status: 412 });
      pauseSyncOnAuthFailure(refusal);
      throw refusal;
    };
  });

  it('does not wipe, does not clear the hint, and still runs the server action', async () => {
    await runClientAction();
    assert.deepEqual(events, ['final-sync', 'server-action']);
  });

  it('keeps the hint naming the other account and records expired', async () => {
    await runClientAction();
    const hint = readSignedInHint();
    assert.equal(hint?.userId, 3);
    assert.equal(hint?.pause?.reason, 'expired');
  });

  it('drops the in-memory session and reports nothing', async () => {
    await runClientAction();
    assert.equal(getSyncSession(), null);
    assert.equal(events.includes('report'), false);
  });
});
