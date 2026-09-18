/**
 * `/explain` answers a signed-in reader's own visibility preference before
 * they ask, and answers a signed-out visitor `null` (M200 spec 03).
 *
 * IT DRIVES THE REAL LOADER WITH A REAL SESSION COOKIE. The user row and the
 * cookie come from `tests/fixtures/user-session.ts`, which seals the cookie with
 * the same `commitUserSession` the sign-in path uses. The preference itself is
 * written through `setHideNewExplanationsByDefault`, the one function the
 * settings action calls, and read back raw from the table before the loader is
 * asked, so a green case cannot come from a write that never landed.
 *
 * THE LANDING STATE HAS NO `q`. Nothing is asked, so nothing is enqueued and
 * nothing is billed.
 *
 * THE ANSWERED STATE IS DRIVEN WITH A QUESTION OVER THE LENGTH CAP. That is the
 * one question the loader answers without any side effect: the resolver refuses
 * it before its rate limiter, its daily counter or its queue, and the loader
 * skips the ask log above the cap. The cases read `explanation_asks` back to
 * prove it, so the claim is checked and not assumed.
 *
 * ISOLATION. Every user comes from the shared fixture and is disposed in
 * `after`, which takes the profile and ask rows with it through the cascade.
 * `after` then reads both tables back to prove none survived.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { explanationAsks, userProfiles } from '../../drizzle/schema';
import { EXPLAIN_MAX_QUESTION_CHARS } from '../../app/lib/translation/limits';
import { setHideNewExplanationsByDefault } from '../../app/models/user-profiles.server';
import { loader } from '../../app/routes/explain';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;
const ORIGIN = 'https://kenning.altan.fyi';

const db = getRawDb();

/** Every user this file made, so `after` removes them even when a case fails midway. */
const sessions: TestUserSession[] = [];

async function openSession(label: string): Promise<TestUserSession> {
  const session = await createTestUserSession(label);
  sessions.push(session);
  return session;
}

/** Every argument the router hands a loader, for one request. */
function routeArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/explain',
    context: new RouterContextProvider(),
  };
}

/** Runs the explain loader as the holder of `cookie`, or as nobody. */
async function loadExplain(options: { cookie: string | null; search: string }) {
  const headers = new Headers();
  if (options.cookie !== null) headers.set('cookie', options.cookie);

  const request = new Request(`${ORIGIN}/explain${options.search}`, { headers });
  return loader(routeArgs(request));
}

/** A question one character past the cap, which the resolver refuses outright. */
function overLongSearch(): string {
  return `?q=${encodeURIComponent('x'.repeat(EXPLAIN_MAX_QUESTION_CHARS + 1))}`;
}

async function readProfileRows(userId: number) {
  return db
    .select({ hide: userProfiles.hideNewExplanationsByDefault })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));
}

async function readAskRows(userId: number) {
  return db.select({ id: explanationAsks.id }).from(explanationAsks).where(eq(explanationAsks.userId, userId));
}

after(async () => {
  const userIds = sessions.map((session) => session.userId);
  await Promise.all(sessions.map((session) => session.dispose()));

  const leftovers =
    userIds.length === 0
      ? { profiles: [], asks: [] }
      : {
          profiles: await db.select().from(userProfiles).where(inArray(userProfiles.userId, userIds)),
          asks: await db.select().from(explanationAsks).where(inArray(explanationAsks.userId, userIds)),
        };

  await poolInitialized;
  await closePool();

  assert.deepEqual(leftovers, { profiles: [], asks: [] }, 'a profile or ask row outlived its user');
});

describe("the landing state carries the reader's own preference", () => {
  it(
    'a reader with no profile row is told false, the public default',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const session = await openSession('explain-notice-default');
      assert.deepEqual(await readProfileRows(session.userId), [], 'the premise: this reader has no profile row');

      const data = await loadExplain({ cookie: session.cookie, search: '' });

      assert.equal(data.hideByDefault, false);
    },
  );

  it(
    'a reader who hides by default is told true',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const session = await openSession('explain-notice-hides');
      await setHideNewExplanationsByDefault(db, { userId: session.userId, hide: true });
      assert.deepEqual(
        await readProfileRows(session.userId),
        [{ hide: true }],
        'the premise: the stored value is true',
      );

      const data = await loadExplain({ cookie: session.cookie, search: '' });

      assert.equal(data.hideByDefault, true);
    },
  );

  it(
    'a signed-out visitor is told null and is not turned away',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const data = await loadExplain({ cookie: null, search: '' });

      assert.equal(data.hideByDefault, null);
      assert.equal(data.signedIn, false);
    },
  );
});

describe('the answered state carries it too', () => {
  it(
    'a reader with no profile row is told false on a question the cap refuses, and nothing is logged',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const session = await openSession('explain-notice-answered-default');

      const data = await loadExplain({ cookie: session.cookie, search: overLongSearch() });

      assert.deepEqual(data.panel, { state: 'budget', reason: 'too-long' });
      assert.equal(data.hideByDefault, false);
      assert.deepEqual(await readAskRows(session.userId), []);
    },
  );

  it(
    'a reader who hides by default is told true on a question the cap refuses, and nothing is logged',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const session = await openSession('explain-notice-answered-hides');
      await setHideNewExplanationsByDefault(db, { userId: session.userId, hide: true });

      const data = await loadExplain({ cookie: session.cookie, search: overLongSearch() });

      assert.deepEqual(data.panel, { state: 'budget', reason: 'too-long' });
      assert.equal(data.hideByDefault, true);
      assert.deepEqual(await readAskRows(session.userId), []);
    },
  );
});
