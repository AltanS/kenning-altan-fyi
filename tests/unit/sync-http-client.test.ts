/**
 * The browser's transport for the synced document, and the header that says
 * which account the device's data belongs to.
 *
 * Pinned: every request carries `X-Kenning-Expected-User` when there is a user
 * to name (the sync session's, unless a caller overrides it) and none when there
 * is not; a 412 arrives as the `account-mismatch` kind with its status, and a 401
 * still arrives as `unauthorized`. `fetch` is a stub that records what it was given.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXPECTED_USER_HEADER, readExpectedUser } from '#app/lib/sync/expected-user';
import { createBrowserSyncHttpClient } from '#app/lib/sync/http-client';
import { isSyncRequestError } from '#app/lib/sync/sync-error';
import { clearSyncSession, setSyncSession } from '#app/lib/sync/sync-session';

interface Seen {
  method: string | undefined;
  headers: Headers;
}

/** A fetch that answers with a fixed response and records each request. */
function recordingFetch(respond: () => Response) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push({ method: init?.method, headers: new Headers(init?.headers) });
    return respond();
  };
  return { fetchImpl, seen };
}

const NOT_FOUND = (): Response => Response.json({ error: 'no blob' }, { status: 404 });
const MISMATCH = (): Response => Response.json({ error: 'account-mismatch' }, { status: 412 });

afterEach(() => {
  clearSyncSession();
});

describe('X-Kenning-Expected-User', () => {
  it('is the sync session user by default, on a pull', async () => {
    setSyncSession({ userId: 12 });
    const { fetchImpl, seen } = recordingFetch(NOT_FOUND);
    await createBrowserSyncHttpClient({ fetchImpl }).pullBlob();
    assert.equal(seen[0]?.headers.get(EXPECTED_USER_HEADER), '12');
  });

  it('is sent on a push as well', async () => {
    setSyncSession({ userId: 12 });
    const { fetchImpl, seen } = recordingFetch(() => Response.json({ newVersion: 1 }));
    await createBrowserSyncHttpClient({ fetchImpl }).pushBlob({ baseVersion: 0, payload: {} });
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.headers.get(EXPECTED_USER_HEADER), '12');
    assert.equal(seen[0]?.headers.get('content-type'), 'application/json');
  });

  it('takes the caller own answer over the session', async () => {
    setSyncSession({ userId: 12 });
    const { fetchImpl, seen } = recordingFetch(NOT_FOUND);
    await createBrowserSyncHttpClient({ fetchImpl, expectedUserId: () => 99 }).pullBlob();
    assert.equal(seen[0]?.headers.get(EXPECTED_USER_HEADER), '99');
  });

  it('is left out when there is nobody to name', async () => {
    const { fetchImpl, seen } = recordingFetch(NOT_FOUND);
    await createBrowserSyncHttpClient({ fetchImpl }).pullBlob();
    assert.equal(seen[0]?.headers.has(EXPECTED_USER_HEADER), false);
  });

  it('reads back through the server parser as the same account', async () => {
    setSyncSession({ userId: 31 });
    const { fetchImpl, seen } = recordingFetch(NOT_FOUND);
    await createBrowserSyncHttpClient({ fetchImpl }).pullBlob();
    assert.deepEqual(readExpectedUser(seen[0]?.headers ?? new Headers()), { kind: 'user', userId: 31 });
  });
});

describe('the refusals', () => {
  it('maps a 412 to account-mismatch, carrying the status', async () => {
    const { fetchImpl } = recordingFetch(MISMATCH);
    const client = createBrowserSyncHttpClient({ fetchImpl, expectedUserId: () => 1 });
    const failure = await client.pullBlob().catch((cause: unknown) => cause);
    assert.ok(isSyncRequestError(failure));
    assert.equal(failure.kind, 'account-mismatch');
    assert.equal(failure.status, 412);
  });

  it('maps a 412 on a push the same way', async () => {
    const { fetchImpl } = recordingFetch(MISMATCH);
    const client = createBrowserSyncHttpClient({ fetchImpl, expectedUserId: () => 1 });
    const failure = await client.pushBlob({ baseVersion: 0, payload: {} }).catch((cause: unknown) => cause);
    assert.ok(isSyncRequestError(failure));
    assert.equal(failure.kind, 'account-mismatch');
  });

  it('still maps a 401 to unauthorized', async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
    const failure = await createBrowserSyncHttpClient({ fetchImpl }).pullBlob().catch((cause: unknown) => cause);
    assert.ok(isSyncRequestError(failure));
    assert.equal(failure.kind, 'unauthorized');
  });
});

const read = (value: string | null): ReturnType<typeof readExpectedUser> => {
  const headers = new Headers();
  if (value !== null) headers.set(EXPECTED_USER_HEADER, value);
  return readExpectedUser(headers);
};


describe('readExpectedUser', () => {
  it('reports a missing header as absent', () => {
    assert.deepEqual(read(null), { kind: 'absent' });
  });

  it('reads a positive integer', () => {
    assert.deepEqual(read('42'), { kind: 'user', userId: 42 });
  });

  it('refuses anything that is not a positive integer in plain digits', () => {
    for (const bad of ['', '0', '-3', '4.5', '1e3', '007', '+5', 'abc', '5,6', '99999999999999999999']) {
      assert.deepEqual(read(bad), { kind: 'invalid' }, JSON.stringify(bad));
    }
  });
});
