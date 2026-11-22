/**
 * THE HISTORY IS ORDERED BY WHEN A SEARCH WAS FIRST TRANSLATED.
 *
 * THE DEFECT THIS FILE HOLDS SHUT. `recordSearch` upserts on the search
 * identity and used to keep `greatest(excluded.at, existing.at)`, so searching
 * a word again, or reopening its entry, bumped its row to the top. A reader
 * scanning for the word they looked up on Tuesday then found the list
 * reshuffled by whatever they had touched since. The instant is now `least(...)`:
 * it is the first-translated instant and a repeat never moves it.
 *
 * THE MAIN CASE is the one the rule is stated in: record A, record B, record A
 * again, and the log still reads B then A, newest first, with A's instant
 * unchanged. The first two rows carry explicit instants in the past so the
 * repeat, which is stamped "now", is strictly later than both and would win
 * under the old `greatest`.
 *
 * THE SECOND CASE is the half that must keep working: a handed-over device row
 * that is OLDER than the stored instant pulls the row earlier, because the
 * search really was first run then.
 *
 * THE THIRD CASE guards the `COALESCE` rule beside it: the repeat starts with no
 * answer, and must not blank the one already stored.
 *
 * ISOLATION. One fixture user per run, deleted in `after`, which cascades onto
 * every row this file wrote. Queries carry a run-scoped suffix.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';

import { searchHistory } from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { listSearchHistory, recordSearch } from '../../app/models/search-history.server';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** A run-scoped suffix, so a repeat run of this file writes fresh queries. */
const RUN = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;

const HOUR_MS = 60 * 60 * 1000;

let reader: TestUserSession | null = null;

/** How many queries this file has invented, so each case gets its own words. */
let invented = 0;

function freshQuery(label: string): string {
  invented += 1;
  return `zzorder${label}${RUN}n${invented}`;
}

/** Records one German-to-English search for the fixture reader. */
async function record(params: { query: string; translation: string | null; at?: Date }): Promise<void> {
  await recordSearch({
    userId: reader?.userId ?? 0,
    query: params.query,
    fromLanguage: 'de',
    toLanguage: 'en',
    headwordId: null,
    translation: params.translation,
    at: params.at,
  });
}

/** The stored instant of one query, in epoch milliseconds. */
async function storedAt(query: string): Promise<number> {
  const [row] = await db
    .select({ at: searchHistory.at })
    .from(searchHistory)
    .where(and(eq(searchHistory.userId, reader?.userId ?? 0), eq(searchHistory.query, query)));
  if (!row) throw new Error(`no history row for ${query}`);
  return row.at.getTime();
}

before(async () => {
  if (!DB_HOST) return;

  reader = await createTestUserSession('history-order');
});

after(async () => {
  if (DB_HOST) await reader?.dispose();

  await poolInitialized;
  await closePool();
});

describe('the search history order', () => {
  it(
    'keeps B above A after A is recorded a second time, and A keeps its first instant',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const a = freshQuery('a');
      const b = freshQuery('b');
      const now = Date.now();

      await record({ query: a, translation: 'alpha', at: new Date(now - 2 * HOUR_MS) });
      await record({ query: b, translation: 'beta', at: new Date(now - HOUR_MS) });
      const firstInstantOfA = await storedAt(a);

      await record({ query: a, translation: 'alpha' });

      assert.equal(await storedAt(a), firstInstantOfA);
      const mine = (await listSearchHistory(reader?.userId ?? 0)).filter((row) => row.query === a || row.query === b);
      assert.deepEqual(
        mine.map((row) => row.query),
        [b, a],
      );
    },
  );

  it(
    'lets a handed-over older row pull the first instant earlier',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const query = freshQuery('c');
      const now = Date.now();

      await record({ query, translation: 'gamma', at: new Date(now - HOUR_MS) });
      await record({ query, translation: 'gamma', at: new Date(now - 5 * HOUR_MS) });

      assert.equal(await storedAt(query), now - 5 * HOUR_MS);
    },
  );

  it(
    'does not blank a stored answer when the repeat arrives with none',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const query = freshQuery('d');

      await record({ query, translation: 'delta' });
      await record({ query, translation: null });

      const row = (await listSearchHistory(reader?.userId ?? 0)).find((entry) => entry.query === query);
      assert.equal(row?.translation, 'delta');
    },
  );
});
