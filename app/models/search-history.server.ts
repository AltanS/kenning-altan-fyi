/**
 * The reader's own search log, as rows in `search_history`.
 *
 * WHY IT IS ON THE SERVER AT ALL is argued at the top of
 * `drizzle/schema/search-history.ts` and recorded in ADR-0011. In one line:
 * the server already reads every word typed, because it searches the corpus
 * with it, and a log that cannot follow a reader to a second device is not a
 * history anybody asked for.
 *
 * THE CAP IS APPLIED ON EVERY WRITE, not on a schedule. A schedule is a second
 * thing that has to run, and the installation whose scheduler never fires is
 * exactly the one holding the log nobody meant to keep. Writing is the only
 * moment the log can grow, so it is the only moment the cap has to be applied.
 * The numbers are the ones the device store used, unchanged, so a reader's log
 * does not silently change size because it moved.
 *
 * NOTHING HERE LOGS A QUERY. This module holds a user id and a typed word in
 * one scope, which makes it one of the few places the product could leak a
 * search log into an operator's log file. It writes no log line at any level.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';

import { searchHistory, type SelectSearchHistory } from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';

/** The most recorded searches one reader keeps, oldest dropped first. */
export const HISTORY_MAX_ENTRIES = 500;
/** The oldest a recorded search may be before it is dropped, in days. */
export const HISTORY_MAX_AGE_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** What a caller supplies for one recorded search. The instant is this module's to assign. */
export interface RecordSearchInput {
  userId: number;
  query: string;
  fromLanguage: string;
  toLanguage: string;
  headwordId: string | null;
  /** The answer this search got, or `null` when it is recorded before one arrived. */
  translation: string | null;
  /**
   * When the search ran. Omitted means now, which is the ordinary case.
   *
   * It is passed only when a device hands over a log it recorded earlier.
   * Taking "now" for those rows would flatten a month of searching into one
   * instant and put the oldest row at the top of the screen.
   */
  at?: Date;
}

/**
 * Records one search, then drops whatever falls outside the cap.
 *
 * AN UPSERT on `(user_id, query, from_language, to_language)`. A search already
 * in the log keeps its row and takes the new instant, headword and answer, so a
 * repeat MOVES a row instead of adding a second copy beside the first. The read
 * below orders on `at`, so moving the instant is moving the row, and no
 * ordering code has to know any of this.
 *
 * AN ANSWER IS NEVER UNWRITTEN BY A LATER `NULL`. The recorder calls this once
 * as soon as the search is on screen and again when the pane has words, and a
 * repeat of the same search starts at `null` again while its own run warms up.
 * Taking that `null` literally would blank an answer the reader can still see,
 * which is why the two answer-carrying columns use `COALESCE(excluded, existing)`
 * rather than `excluded` outright.
 */
export async function recordSearch(input: RecordSearchInput): Promise<void> {
  const db = getRawDb();
  const at = input.at ?? new Date();
  await db
    .insert(searchHistory)
    .values({
      userId: input.userId,
      query: input.query,
      fromLanguage: input.fromLanguage,
      toLanguage: input.toLanguage,
      headwordId: input.headwordId,
      translation: input.translation,
      at,
    })
    .onConflictDoUpdate({
      target: [searchHistory.userId, searchHistory.query, searchHistory.fromLanguage, searchHistory.toLanguage],
      set: {
        // NEVER BACKWARDS. A handed-over row must not drag a search the reader
        // ran today back to the instant they first ran it a month ago.
        at: sql`greatest(excluded.at, ${searchHistory.at})`,
        headwordId: sql`coalesce(excluded.headword_id, ${searchHistory.headwordId})`,
        translation: sql`coalesce(excluded.translation, ${searchHistory.translation})`,
      },
    });

  await pruneHistory(input.userId);
}

/**
 * Drops what falls outside either half of the cap, for one reader.
 *
 * BOTH halves are applied, and the age half first: a reader who searched once a
 * year for ten years is under the count cap and still holding a decade of
 * queries, and a reader who searched 900 times this morning is inside the age
 * window and still over the count.
 */
export async function pruneHistory(userId: number, nowMs: number = Date.now()): Promise<void> {
  const db = getRawDb();
  const oldestKept = new Date(nowMs - HISTORY_MAX_AGE_DAYS * MS_PER_DAY);

  await db.delete(searchHistory).where(and(eq(searchHistory.userId, userId), lt(searchHistory.at, oldestKept)));

  // The count half, expressed as "everything below the newest N". A subquery
  // rather than a read-then-delete: two searches landing at once would each
  // read the same survivor list and delete on a view of the table that no
  // longer held.
  const survivors = db
    .select({ id: searchHistory.id })
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .orderBy(desc(searchHistory.at), desc(searchHistory.id))
    .limit(HISTORY_MAX_ENTRIES);

  await db
    .delete(searchHistory)
    .where(and(eq(searchHistory.userId, userId), sql`${searchHistory.id} not in (${survivors})`));
}

/**
 * One reader's log, newest first.
 *
 * @param limit - how many rows to return. The overview asks for a handful and
 *   the history screen asks for the cap, so the ceiling is the cap itself
 *   rather than an unbounded read.
 */
export async function listSearchHistory(userId: number, limit: number = HISTORY_MAX_ENTRIES): Promise<SelectSearchHistory[]> {
  const db = getRawDb();
  return db
    .select()
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .orderBy(desc(searchHistory.at), desc(searchHistory.id))
    .limit(Math.min(limit, HISTORY_MAX_ENTRIES));
}

/**
 * Drops one reader's whole log. A HARD delete: there is nothing to converge
 * with and no peer to tell, so "clear" here means cleared.
 *
 * @returns how many rows went, so the caller can report a real number.
 */
export async function clearSearchHistory(userId: number): Promise<number> {
  const db = getRawDb();
  const deleted = await db.delete(searchHistory).where(eq(searchHistory.userId, userId)).returning({ id: searchHistory.id });
  return deleted.length;
}
