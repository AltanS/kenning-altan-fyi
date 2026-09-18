/**
 * A signed-in reader sets a public name, clears it, and flips the
 * default-visibility switch, all through the real `/settings` action (M199).
 *
 * IT DRIVES THE REAL ACTION AND LOADER, WITH A REAL SESSION COOKIE. The user
 * row and the cookie both come from `tests/fixtures/user-session.ts`, which
 * seals the cookie with the same `commitUserSession` the sign-in path uses. A
 * hand-built cookie would prove only that this file can write a header.
 *
 * WHAT THIS FILE HOLDS IN PLACE. Setting the name and clearing it are two
 * different intents on one action; toggling the switch is a third. The order
 * of the walk matters: the switch is set AFTER the name is cleared, so a
 * regression that resurrects the old delete-on-clear behaviour would show up
 * here as the toggle losing the value it was never touched by.
 *
 * ISOLATION. One user, from the shared fixture, disposed in `after()`.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import { closePool, poolInitialized } from '../../drizzle/db';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';
import { action, loader, type SettingsActionResult } from '../../app/routes/settings';

const DB_HOST = process.env.DB_HOST;
const ORIGIN = 'https://kenning.altan.fyi';

let session: TestUserSession | null = null;

/** Every argument the router hands an action or a loader, for one request. */
function routeArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/settings',
    context: new RouterContextProvider(),
  };
}

/** Submits the settings form, exactly as one of the two cards' fetchers does. */
async function submit(fields: Record<string, string>, cookie: string | null): Promise<SettingsActionResult> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);

  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);

  const request = new Request(`${ORIGIN}/settings`, { method: 'POST', headers, body });
  return action(routeArgs(request));
}

/** Reads the profile back through the real loader, exactly as a page load does. */
async function readProfile(cookie: string | null) {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);

  const request = new Request(`${ORIGIN}/settings`, { headers });
  return loader(routeArgs(request));
}

after(async () => {
  await session?.dispose();
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. See
  // `signed-in-visitor-leaves-the-doors.test.ts` for why this order matters.
  await poolInitialized;
  await closePool();
});

describe('a signed-out visitor gets no profile and no write', () => {
  it(
    'the loader answers signed-out with no profile',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.deepEqual(await readProfile(null), { isSignedIn: false, profile: null });
    },
  );

  it(
    'the action refuses a write with no session, and writes nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const result = await submit({ intent: 'set-name', publicName: 'Nobody' }, null);
      assert.deepEqual(result, { success: false, intent: null, error: 'unauthenticated' });
    },
  );
});

describe('the walk: set a name, clear it, then flip the switch', () => {
  it(
    'starts with the all-defaults profile',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      session = await createTestUserSession('settings-walk');
      assert.deepEqual(await readProfile(session.cookie), {
        isSignedIn: true,
        profile: { publicName: null, hideNewExplanationsByDefault: false },
      });
    },
  );

  it(
    'refuses a name shorter than the floor, and writes nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session, 'the walk must run in order');
      const cookie = session?.cookie ?? '';
      const result = await submit({ intent: 'set-name', publicName: 'a' }, cookie);
      assert.deepEqual(result, { success: false, intent: 'set-name', error: 'invalid-name' });
      assert.equal((await readProfile(cookie)).profile?.publicName, null);
    },
  );

  it(
    'refuses the reserved product name',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session, 'the walk must run in order');
      const cookie = session?.cookie ?? '';
      const result = await submit({ intent: 'set-name', publicName: 'Kenning' }, cookie);
      assert.deepEqual(result, { success: false, intent: 'set-name', error: 'invalid-name' });
    },
  );

  it(
    'saves a valid public name',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session, 'the walk must run in order');
      const cookie = session?.cookie ?? '';
      const result = await submit({ intent: 'set-name', publicName: '  Reader Walk  ' }, cookie);
      assert.deepEqual(result, { success: true, intent: 'set-name', publicName: 'Reader Walk' });
      assert.deepEqual(await readProfile(cookie), {
        isSignedIn: true,
        profile: { publicName: 'Reader Walk', hideNewExplanationsByDefault: false },
      });
    },
  );

  it(
    'clears the name',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session, 'the walk must run in order');
      const cookie = session?.cookie ?? '';
      const result = await submit({ intent: 'clear-name' }, cookie);
      assert.deepEqual(result, { success: true, intent: 'clear-name' });
      assert.deepEqual(await readProfile(cookie), {
        isSignedIn: true,
        profile: { publicName: null, hideNewExplanationsByDefault: false },
      });
    },
  );

  it(
    'flips the default-visibility switch AFTER the name was cleared, and it lands and stays',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session, 'the walk must run in order');
      const cookie = session?.cookie ?? '';
      const result = await submit({ intent: 'set-hide-default', hide: 'true' }, cookie);
      assert.deepEqual(result, { success: true, intent: 'set-hide-default', hide: true });

      // THE ASSERTION THAT MATTERS. The name stays cleared, the toggle is on,
      // and nothing has resurrected a row that carries a stale name.
      assert.deepEqual(await readProfile(cookie), {
        isSignedIn: true,
        profile: { publicName: null, hideNewExplanationsByDefault: true },
      });
    },
  );

  it(
    'setting a fresh name after all of that still leaves the switch on',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session, 'the walk must run in order');
      const cookie = session?.cookie ?? '';
      await submit({ intent: 'set-name', publicName: 'Reader Walk Two' }, cookie);

      assert.deepEqual(await readProfile(cookie), {
        isSignedIn: true,
        profile: { publicName: 'Reader Walk Two', hideNewExplanationsByDefault: true },
      });
    },
  );
});

/**
 * Two separate readers, one folded name, the SQLSTATE 23505 catch at the top
 * of `action` (settings.tsx).
 *
 * TWO INDEPENDENT SESSIONS, NOT THE SHARED WALK ABOVE. The ordered walk
 * reuses one `session` across its whole describe block, which is wrong for a
 * collision case: this needs a second, genuinely distinct reader to collide
 * with the first.
 */
describe('the folded name is unique across readers', () => {
  let sessionA: TestUserSession | null = null;
  let sessionB: TestUserSession | null = null;

  after(async () => {
    await sessionA?.dispose();
    await sessionB?.dispose();
  });

  it(
    "refuses a second reader the same folded name, and leaves the first reader's row untouched",
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      sessionA = await createTestUserSession('name-taken-a');
      sessionB = await createTestUserSession('name-taken-b');

      const first = await submit({ intent: 'set-name', publicName: 'Shared Reader' }, sessionA.cookie);
      assert.deepEqual(first, { success: true, intent: 'set-name', publicName: 'Shared Reader' });

      // Differs only in case and surrounding whitespace: the same folded form.
      const second = await submit({ intent: 'set-name', publicName: '  SHARED READER  ' }, sessionB.cookie);
      assert.deepEqual(second, { success: false, intent: 'set-name', error: 'name-taken' });

      // THE ASSERTION THAT MATTERS. The collision on `publicNameFolded` did
      // not corrupt, clear, or otherwise touch the first reader's own row.
      assert.deepEqual(await readProfile(sessionA.cookie), {
        isSignedIn: true,
        profile: { publicName: 'Shared Reader', hideNewExplanationsByDefault: false },
      });

      // And the refused write left the second reader with no name at all,
      // never a half-written one.
      assert.deepEqual(await readProfile(sessionB.cookie), {
        isSignedIn: true,
        profile: { publicName: null, hideNewExplanationsByDefault: false },
      });
    },
  );
});
