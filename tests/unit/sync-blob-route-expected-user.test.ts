/**
 * `/api/v1/sync/blob` and the account the sender says its data belongs to.
 *
 * A device store belongs to ONE account, and the cookie names whoever is signed
 * in now. The client sends `X-Kenning-Expected-User`, and the route must answer
 * `412 account-mismatch` BEFORE it reads or writes anything when that is not the
 * session's user. The cases:
 *
 *   - a mismatch is a 412 on a pull and on a push, and the blob store is never
 *     touched (counted, not assumed);
 *   - a matching header goes through;
 *   - NO header means no check, so a tab on an older build keeps working;
 *   - a header that is not a positive integer is a 400, also with no read or write;
 *   - an unauthenticated caller is still a 401 whatever the header says.
 *
 * `#drizzle/db` connects at module load, so the two modules that reach it are
 * replaced. The route is called directly with a `Request`.
 */
import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

const SESSION_USER = { id: 5, email: 'reader@example.test', isSuperadmin: false };

/** Which user the faked session resolves to; `null` is a signed-out caller. */
let signedInAs: typeof SESSION_USER | null = SESSION_USER;

/** Every blob-store call, in order. */
let storeCalls: string[] = [];

mock.module('#app/middleware/auth', {
  namedExports: { resolveUser: () => Promise.resolve(signedInAs) },
});

mock.module('#app/lib/sync/server/blob-store.server', {
  namedExports: {
    MAX_BLOB_BYTES: 2 * 1024 * 1024,
    readBlob: () => {
      storeCalls.push('read');
      return Promise.resolve({ blobVersion: 3, payload: { ok: true }, createdAt: new Date(0) });
    },
    putBlobIfVersionMatches: () => {
      storeCalls.push('write');
      return Promise.resolve({ status: 'accepted', newVersion: 4 });
    },
  },
});

mock.module('#app/lib/logger', {
  namedExports: { createComponentLogger: () => ({ warn: () => undefined, info: () => undefined, error: () => undefined }) },
});

const { loader, action } = await import('#app/routes/api.v1.sync.blob');

const URL_ = 'https://kenning.altan.fyi/api/v1/sync/blob';

function pull(headers: Record<string, string>): Promise<Response> {
  // SAFETY: the route reads only `request` from its args, so the rest of the
  // framework's argument object is never touched. Passing the one field it reads
  // is the whole contract under test.
  return loader({ request: new Request(URL_, { headers }) } as never);
}

function push(headers: Record<string, string>): Promise<Response> {
  const request = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ baseVersion: 3, payload: { ok: true } }),
  });
  // SAFETY: same as `pull`; the action reads only `request`.
  return action({ request } as never);
}

beforeEach(() => {
  signedInAs = SESSION_USER;
  storeCalls = [];
});

describe('a header naming another account', () => {
  it('is refused with 412 on a pull, and nothing is read', async () => {
    const response = await pull({ 'X-Kenning-Expected-User': '9' });
    assert.equal(response.status, 412);
    assert.deepEqual(await response.json(), { error: 'account-mismatch' });
    assert.deepEqual(storeCalls, []);
  });

  it('is refused with 412 on a push, and nothing is written', async () => {
    const response = await push({ 'X-Kenning-Expected-User': '9' });
    assert.equal(response.status, 412);
    assert.deepEqual(await response.json(), { error: 'account-mismatch' });
    assert.deepEqual(storeCalls, []);
  });
});

describe('a header naming the signed-in account', () => {
  it('lets a pull through', async () => {
    const response = await pull({ 'X-Kenning-Expected-User': '5' });
    assert.equal(response.status, 200);
    assert.deepEqual(storeCalls, ['read']);
  });

  it('lets a push through', async () => {
    const response = await push({ 'X-Kenning-Expected-User': '5' });
    assert.equal(response.status, 200);
    assert.deepEqual(storeCalls, ['write']);
  });
});

describe('no header', () => {
  it('means no check on a pull, so an older tab keeps working', async () => {
    const response = await pull({});
    assert.equal(response.status, 200);
    assert.deepEqual(storeCalls, ['read']);
  });

  it('means no check on a push', async () => {
    const response = await push({});
    assert.equal(response.status, 200);
    assert.deepEqual(storeCalls, ['write']);
  });
});

describe('a malformed header', () => {
  for (const bad of ['abc', '0', '-5', '5.5', '007']) {
    it(`${JSON.stringify(bad)} is a 400 on a pull, with no read`, async () => {
      const response = await pull({ 'X-Kenning-Expected-User': bad });
      assert.equal(response.status, 400);
      assert.deepEqual(storeCalls, []);
    });

    it(`${JSON.stringify(bad)} is a 400 on a push, with no write`, async () => {
      const response = await push({ 'X-Kenning-Expected-User': bad });
      assert.equal(response.status, 400);
      assert.deepEqual(storeCalls, []);
    });
  }
});

describe('a signed-out caller', () => {
  it('is a 401 on both verbs whatever the header says', async () => {
    signedInAs = null;
    assert.equal((await pull({ 'X-Kenning-Expected-User': '5' })).status, 401);
    assert.equal((await push({ 'X-Kenning-Expected-User': '5' })).status, 401);
    assert.deepEqual(storeCalls, []);
  });
});
