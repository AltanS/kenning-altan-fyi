/**
 * The reader's own ask log, as rows in `explanation_asks`.
 *
 * WHY THERE ARE TWO TABLES is argued at the top of
 * `drizzle/schema/explanation-asks.ts`. In one line: `explanations` is a shared
 * ledger keyed by the question and carrying no reader at all, so it cannot say
 * what anybody asked, and it must not learn.
 *
 * EVERY FUNCTION TAKES THE READER FIRST, AND IT IS ALWAYS PART OF THE WHERE
 * CLAUSE. `getExplanationAsk` and `removeExplanationAsk` both match on the id
 * AND the user, so a guessed row id from another account reads as "no such row"
 * rather than as somebody else's question. An id-only read with a check
 * afterwards would be the same query with one more chance to forget the check.
 *
 * NOTHING HERE LOGS A QUESTION. This module holds an account id and free text a
 * person typed in one scope, which makes it one of the few places the product
 * could turn its own log file into a transcript. It writes no log line at any
 * level, the same rule `app/models/search-history.server.ts` follows. Keep it
 * that way.
 */
import { and, count, desc, eq, sql } from 'drizzle-orm';

import { explanationAsks, type SelectExplanationAsk } from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';

/** The most asks one page of the list screen adds. */
export const EXPLANATION_ASKS_PAGE_SIZE = 20;

/**
 * The most rows one read may return, whatever it asks for.
 *
 * THE SCREEN GROWS ITS WINDOW RATHER THAN PAGING THROUGH IT: "show more" asks
 * for the same rows plus twenty, so the URL alone says what is on screen and the
 * back button works. That makes the limit a reader-controlled number, so it
 * needs a ceiling, and this is it. Ten presses of a button nobody presses ten
 * times.
 */
export const EXPLANATION_ASKS_MAX_ROWS = 200;

/** What a caller supplies for one recorded ask. The instant is this module's to assign. */
export interface RecordExplanationAskInput {
  userId: number;
  /** As typed, trimmed. It is what a re-ask would send. */
  question: string;
  /** `normalizeQuery(question, from).normalized`, which is the identity's fourth column. */
  questionNormalized: string;
  /** The languages the ask RAN in, after detection resolved, never the reader's raw statement. */
  fromLanguage: string;
  toLanguage: string;
}

/**
 * Records one ask.
 *
 * AN UPSERT on `(user_id, from_language, to_language, question_normalized)`. A
 * question already in the log keeps its row and takes the new instant and the
 * new raw text, so asking the same thing again MOVES a row rather than adding a
 * second copy beside the first. The read below orders on `asked_at`, so moving
 * the instant is moving the row, and no ordering code has to know any of this.
 *
 * THE RAW TEXT IS OVERWRITTEN AND THE FOLDED TEXT IS NOT, because the folded
 * text is the identity and cannot differ. Overwriting the raw text means the row
 * says what the reader wrote the LAST time they asked, which is the wording they
 * will recognise on the list.
 */
export async function recordExplanationAsk(input: RecordExplanationAskInput): Promise<void> {
  const db = getRawDb();
  await db
    .insert(explanationAsks)
    .values({
      userId: input.userId,
      question: input.question,
      questionNormalized: input.questionNormalized,
      fromLanguage: input.fromLanguage,
      toLanguage: input.toLanguage,
    })
    .onConflictDoUpdate({
      target: [
        explanationAsks.userId,
        explanationAsks.fromLanguage,
        explanationAsks.toLanguage,
        explanationAsks.questionNormalized,
      ],
      set: { question: input.question, askedAt: sql`now()` },
    });
}

/** One page of the ask list. */
export interface ExplanationAskPage {
  /** This page's rows, newest first. */
  rows: SelectExplanationAsk[];
  /** Every ask this reader has, so the screen can say whether a next page exists. */
  total: number;
}

/** Where one page starts and how long it is. */
export interface ExplanationAskPageParams {
  limit?: number;
  offset?: number;
}

/**
 * One reader's asks, newest first.
 *
 * THE COUNT RUNS BESIDE THE PAGE, not after it, which is the shape every list
 * model in this app uses: a "show more" control that does not know the total
 * either guesses or asks for one row more than it shows, and both are a rule
 * living on the screen instead of in the query.
 *
 * @param userId Whose log.
 * @param params The window. The limit is clamped to `EXPLANATION_ASKS_MAX_ROWS`,
 *   so a hand-edited query string cannot ask for the whole log in one request.
 */
export async function listExplanationAsks(
  userId: number,
  params: ExplanationAskPageParams = {},
): Promise<ExplanationAskPage> {
  const db = getRawDb();
  const limit = Math.min(params.limit ?? EXPLANATION_ASKS_PAGE_SIZE, EXPLANATION_ASKS_MAX_ROWS);
  const offset = Math.max(params.offset ?? 0, 0);

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(explanationAsks)
      .where(eq(explanationAsks.userId, userId))
      .orderBy(desc(explanationAsks.askedAt), desc(explanationAsks.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ value: count() })
      .from(explanationAsks)
      .where(eq(explanationAsks.userId, userId))
      .then((result) => result[0]),
  ]);

  return { rows, total: Number(totalRow?.value ?? 0) };
}

/**
 * One ask of this reader's, or null.
 *
 * NULL COVERS BOTH "no such row" AND "not yours", deliberately and with no way
 * to tell them apart: the detail page answers a 404 either way, so a row that
 * exists under another account is indistinguishable from one that never
 * existed.
 */
export async function getExplanationAsk(userId: number, id: number): Promise<SelectExplanationAsk | null> {
  const db = getRawDb();
  const rows = await db
    .select()
    .from(explanationAsks)
    .where(and(eq(explanationAsks.userId, userId), eq(explanationAsks.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Drops one ask. A HARD delete: there is no peer to converge with and nothing
 * for a tombstone to tell, so "remove" here means removed.
 *
 * THE ANSWER IN `explanations` IS UNTOUCHED, and that is correct rather than an
 * oversight. That row is the installation's own record of a paid run and its
 * cache of the reply; it names nobody, so there is nothing of this reader in it
 * to remove. What goes is the link between the person and the question.
 *
 * @returns Whether a row went, so the caller can answer a repeated submit
 *   honestly rather than reporting a removal that removed nothing.
 */
export async function removeExplanationAsk(userId: number, id: number): Promise<boolean> {
  const db = getRawDb();
  const deleted = await db
    .delete(explanationAsks)
    .where(and(eq(explanationAsks.userId, userId), eq(explanationAsks.id, id)))
    .returning({ id: explanationAsks.id });
  return deleted.length > 0;
}
