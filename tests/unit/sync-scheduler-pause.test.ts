/**
 * The sync scheduler and a refused session.
 *
 * THE DEFECT. The scheduler ran `runSyncCycleForCurrentSession` directly, so the
 * 401 handling in `sync-client.ts` never saw a 401 from the real path. The
 * session stayed installed, and every focus, `online` and local edit sent the
 * same refused request again, with `reportError` logging each one.
 *
 * WHAT IS ASSERTED, with a REAL http client behind a counting `fetch` so that
 * "a request" is a request:
 *   - one 401 sends one request, pauses sync as `expired`, drops the session and
 *     reports nothing;
 *   - then a `focus`, an `online` and a local write send NO further request;
 *   - the same holds when the 401 is met by a queued outbox intent, through the
 *     intent runner, not just the cycle runner;
 *   - a 412 pauses as `other-account` the same way;
 *   - defence in depth: with a pause on the hint, a stale installed session is
 *     still not enough to send anything, from any trigger.
 *
 * The local store barrel is replaced by a small fake outbox that runs the
 * installed runner when an intent is pending and leaves it pending on an auth
 * stop, which is what the real flush does. Window events are captured by a stub
 * `window`.
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { OutboxRunner } from '#app/lib/local-store/outbox';
import type { OutboxRecord } from '#app/lib/local-store/types';

/** Handlers the scheduler registered on the stub window, by event name. */
const windowHandlers = new Map<string, () => void>();

/** Table listeners the scheduler registered on the fake store. */
let tableListeners: Array<() => void> = [];

/** The fake outbox: whether an intent is waiting, and what to run it with. */
let hasPendingIntent = false;
let installedRunner: OutboxRunner | null = null;

/** The one queued intent, as the real outbox would hand it to the runner. */
const QUEUED_INTENT: OutboxRecord = {
  clientId: 'intent-1',
  intent: 'sync',
  sequence: 1,
  createdAt: 0,
  status: 'pending',
  attempts: 0,
  nextAttemptAt: 0,
  lastError: '',
};
let enqueueCount = 0;

mock.module('#app/lib/local-store', {
  namedExports: {
    enqueueSyncIntent: () => {
      enqueueCount += 1;
      hasPendingIntent = true;
      return Promise.resolve({});
    },
    flushOutboxOnce: async () => {
      if (!hasPendingIntent || installedRunner === null) return { flushed: 0 };
      const result = await installedRunner(QUEUED_INTENT);
      if (result.ok) hasPendingIntent = false;
      return { flushed: result.ok ? 1 : 0 };
    },
    getPrimaryStore: () =>
      Promise.resolve({
        addTablesListener: (listener: () => void) => {
          tableListeners.push(listener);
          return 1;
        },
        delListener: () => undefined,
      }),
    setOutboxRunner: (runner: OutboxRunner | null) => {
      installedRunner = runner;
    },
  },
});

/** Every call to `reportError`. Must stay empty: an auth refusal is a state, not a fault. */
const reported: unknown[] = [];
mock.module('#app/lib/report-error', {
  namedExports: { reportError: (cause: unknown) => void reported.push(cause) },
});

/** Every request the http client sent, and what the server should answer next. */
let requests = 0;
let nextStatus = 401;

const { createBrowserSyncHttpClient } = await import('#app/lib/sync/http-client');

mock.module('#app/lib/sync/orchestrator', {
  namedExports: {
    runSyncCycleForCurrentSession: async () => {
      const fetchImpl: typeof fetch = () => {
        requests += 1;
        return Promise.resolve(Response.json({ error: 'refused' }, { status: nextStatus }));
      };
      await createBrowserSyncHttpClient({ fetchImpl }).pullBlob();
      return {};
    },
  },
});

const { PUSH_DEBOUNCE_MS, startSyncScheduler } = await import('#app/lib/sync/scheduler');
const { readSignedInHint, replaceSignedInHint } = await import('#app/lib/auth/signed-in-hint');
const { clearSyncSession, getSyncSession, setSyncSession } = await import('#app/lib/sync/sync-session');

/** Lets every pending promise continuation run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function fire(event: string): void {
  windowHandlers.get(event)?.();
}

let stopScheduler: (() => void) | null = null;

beforeEach(() => {
  windowHandlers.clear();
  tableListeners = [];
  hasPendingIntent = false;
  installedRunner = null;
  enqueueCount = 0;
  reported.length = 0;
  requests = 0;
  nextStatus = 401;

  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (name: string, handler: () => void) => void windowHandlers.set(name, handler),
      removeEventListener: (name: string) => void windowHandlers.delete(name),
    },
  });
});

afterEach(() => {
  stopScheduler?.();
  stopScheduler = null;
  clearSyncSession();
  mock.timers.reset();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('one refused request pauses sync', () => {
  it('sends a single request for a 401, then nothing on focus, online or a local write', async () => {
    replaceSignedInHint(1);
    setSyncSession({ userId: 1 });
    stopScheduler = startSyncScheduler();
    await settle();

    assert.equal(requests, 1, 'the boot trigger sends the one request that learns the session is dead');
    assert.equal(getSyncSession(), null, 'a refused session is dropped');
    assert.equal(readSignedInHint()?.pause?.reason, 'expired');
    assert.equal(readSignedInHint()?.userId, 1, 'the hint is never cleared by a 401');

    fire('focus');
    await settle();
    fire('online');
    await settle();
    for (const listener of tableListeners) listener();
    await settle();

    assert.equal(requests, 1, 'focus, online and a local write must send nothing more');
    assert.equal(enqueueCount, 0, 'and must not queue an intent either');
    assert.deepEqual(reported, [], 'an expired session is a state, not a fault to report');
  });

  it('pauses the same way when a queued intent meets the 401', async () => {
    replaceSignedInHint(1);
    setSyncSession({ userId: 1 });
    hasPendingIntent = true;
    stopScheduler = startSyncScheduler();
    await settle();

    assert.equal(requests, 1, 'the intent runner sends it, and the cycle after the flush does not repeat it');
    assert.equal(getSyncSession(), null);
    assert.equal(readSignedInHint()?.pause?.reason, 'expired');
    assert.equal(hasPendingIntent, true, 'the intent stays queued for when the account is back');

    fire('focus');
    fire('online');
    await settle();
    assert.equal(requests, 1);
    assert.deepEqual(reported, []);
  });

  it('pauses as other-account on a 412', async () => {
    nextStatus = 412;
    replaceSignedInHint(1);
    setSyncSession({ userId: 1 });
    stopScheduler = startSyncScheduler();
    await settle();

    assert.equal(requests, 1);
    assert.equal(getSyncSession(), null);
    assert.equal(readSignedInHint()?.pause?.reason, 'other-account');

    fire('focus');
    fire('online');
    await settle();
    assert.equal(requests, 1);
    assert.deepEqual(reported, []);
  });

  it('still reports a failure that is not an auth refusal', async () => {
    nextStatus = 500;
    replaceSignedInHint(1);
    setSyncSession({ userId: 1 });
    stopScheduler = startSyncScheduler();
    await settle();

    assert.equal(requests, 1);
    assert.equal(reported.length, 1, 'a 500 is unexpected and is reported');
    assert.equal(readSignedInHint()?.pause, undefined, 'and does not pause sync');
    assert.deepEqual(getSyncSession(), { userId: 1 });
  });
});

describe('defence in depth: a paused hint beats a stale session', () => {
  it('sends nothing from focus, online, a session install or a settled local write', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    replaceSignedInHint(1);
    stopScheduler = startSyncScheduler();
    await settle();

    // The pause is already on the hint, and a session is installed anyway, as it
    // is for one render between the scheduler writing a pause and `_app.tsx`
    // dropping the session.
    const { setSyncPause } = await import('#app/lib/auth/signed-in-hint');
    setSyncPause('expired');
    setSyncSession({ userId: 1 });
    await settle();
    fire('focus');
    fire('online');
    await settle();
    for (const listener of tableListeners) listener();
    mock.timers.tick(PUSH_DEBOUNCE_MS + 1);
    await settle();

    assert.equal(requests, 0, 'no request at all');
    assert.equal(enqueueCount, 0, 'no intent queued by the debounced write');
    assert.deepEqual(reported, []);
  });
});
