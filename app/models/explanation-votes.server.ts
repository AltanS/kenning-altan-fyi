/**
 * Votes on one written explanation, and the operator's view of the bad ones.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *   The same rule `translation-votes.server.ts` follows, for the same reason:
 *   `drizzle/db.ts` opens a connection pool at module load, and this module is
 *   reached from a route action holding `getRawDb()` and from an admin page
 *   holding its own handle. Only the TYPE is imported, so importing this file
 *   opens nothing.
 *
 * EVERY TABLE HERE IS SHARED. `explanation_votes` and `explanations` both
 * describe this installation's one ledger of answered questions, so `getRawDb()`
 * is the correct handle and no filter narrows these statements to a reader.
 *
 * THE GOVERNANCE THAT SHAPES THE READS, AND WHY IT IS STRICTER HERE.
 *   A vote row holds an explanation id and an account id and nothing else, and
 *   `drizzle/schema/votes.ts` says why. An explanation id is not a shared-zone
 *   object the way an enrichment id is: the row exists because somebody typed
 *   that question. So this file offers NO per-reader listing, no export and no
 *   path from an account to the questions it judged. The reads a reader's own
 *   browser triggers, `castExplanationVote`, `tallyExplanationVotes` and
 *   `readVoteForAccount`, are all keyed on an id the reader is already looking
 *   at, and none of them returns the text of anything.
 *
 *   `listDownVotedExplanations` DOES name questions, and it is sound for a
 *   reason worth stating rather than assuming. It groups the account column away
 *   before anything is selected, and the account column is neither selected nor
 *   filtered on, so what comes out is "this answer scored badly", never "this
 *   reader judged this question". It joins the ledger and nothing else: the
 *   authorship table and the profile table are deliberately out of reach, so an
 *   operator triaging a down-voted answer cannot also learn who asked for it
 *   from the same screen. Selecting the account column here, or joining either
 *   of those two tables, would defeat both claims at once.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { VoteTally } from '#app/lib/votes/score';
import type { VoteValue } from '#app/models/votes.server';
import { explanationVotes, explanations } from '#drizzle/schema';

/**
 * The two counted expressions every tally here shares.
 *
 * ONE QUERY, NOT TWO. `count(*) filter (where ...)` computes both directions in
 * a single pass over the same index range, and two round trips would also be two
 * MOMENTS: a vote landing between them produces a tally that never existed.
 */
const UP_COUNT = sql<number>`count(*) filter (where ${explanationVotes.value} = 1)`.mapWith(Number);
const DOWN_COUNT = sql<number>`count(*) filter (where ${explanationVotes.value} = -1)`.mapWith(Number);

export interface CastExplanationVoteParams {
  explanationId: string;
  accountId: number;
  value: VoteValue;
}

/**
 * Record one reader's vote on one explanation, replacing their previous one.
 *
 * THE UPSERT IS THE "ONE VOTE PER READER PER EXPLANATION" RULE, AND IT IS NOT
 * OPTIONAL. The target is the composite primary key
 * `(explanationId, accountId)`. A plain insert would append a second row, the
 * tally would count one person twice, and anybody could push a score as far as
 * they liked by clicking again.
 *
 * @param db The database handle.
 * @param params The explanation, the account, and the direction of the vote.
 */
export async function castExplanationVote(db: DictionaryDb, params: CastExplanationVoteParams): Promise<void> {
  await db
    .insert(explanationVotes)
    .values({
      explanationId: params.explanationId,
      accountId: params.accountId,
      value: params.value,
    })
    .onConflictDoUpdate({
      target: [explanationVotes.explanationId, explanationVotes.accountId],
      // `updatedAt` is moved explicitly. Drizzle's `$onUpdate` fires on its own
      // `update` statements, not inside a conflict clause, so leaving it out
      // would freeze the column at the time of the reader's FIRST vote.
      set: { value: params.value, updatedAt: new Date() },
    });
}

/**
 * The up and down counts for one explanation.
 *
 * @param db The database handle.
 * @param explanationId The answer to count votes for.
 * @returns both counts, zeroed when nobody has voted.
 */
export async function tallyExplanationVotes(db: DictionaryDb, explanationId: string): Promise<VoteTally> {
  const [row] = await db
    .select({ up: UP_COUNT, down: DOWN_COUNT })
    .from(explanationVotes)
    .where(eq(explanationVotes.explanationId, explanationId));

  return { up: row?.up ?? 0, down: row?.down ?? 0 };
}

/**
 * Whether this id names an ANSWERED explanation.
 *
 * READ BEFORE THE VOTE IS CAST, AND IT MATCHES `status = 'ok'` ON PURPOSE.
 * `explanation_votes.explanationId` is a foreign key, so inserting against an
 * unknown id would fail as a database error deep in the action; reading first
 * turns a stale id from an old open tab into an ordinary 400. The status
 * predicate does the second half of the job: a `pending`, `failed` or `budget`
 * row is a real ledger row the foreign key would happily accept, and a vote on
 * it would be a judgement of prose that does not exist. There is nothing to be
 * accurate or inaccurate about until an answer is written.
 *
 * The function returns the id rather than a boolean so the caller writes the
 * value the DATABASE confirmed, not the one the browser sent.
 *
 * @param db The database handle.
 * @param explanationId The ledger row to look for.
 * @returns the id, or `null` when nothing answered carries it.
 */
export async function readExplanationRow(db: DictionaryDb, explanationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: explanations.id })
    .from(explanations)
    .where(and(eq(explanations.id, explanationId), eq(explanations.status, 'ok')))
    .limit(1);

  return row?.id ?? null;
}

export interface ReadVoteForAccountParams {
  explanationId: string;
  accountId: number;
}

/**
 * This one reader's own vote on this one explanation, if they cast one.
 *
 * A SINGLE-ROW EQUALITY READ ON THE COMPOSITE KEY, and it is keyed on the
 * explanation FIRST. An explanation is rendered one at a time, so the caller
 * always holds the id already; there is deliberately no variant that starts from
 * the account and asks what it has voted on. See this file's header.
 *
 * @param db The database handle.
 * @param params The explanation on screen, and the signed-in reader.
 * @returns `-1`, `1`, or `null` when this reader has not voted on it.
 */
export async function readVoteForAccount(
  db: DictionaryDb,
  params: ReadVoteForAccountParams,
): Promise<VoteValue | null> {
  const [row] = await db
    .select({ value: explanationVotes.value })
    .from(explanationVotes)
    .where(
      and(
        eq(explanationVotes.explanationId, params.explanationId),
        eq(explanationVotes.accountId, params.accountId),
      ),
    )
    .limit(1);

  if (row === undefined) return null;
  return row.value === 1 ? 1 : -1;
}

/** One down-voted explanation, as the operator's page renders it. */
export interface DownVotedExplanationView {
  explanationId: string;
  /** The question itself, which is what the answer under judgement was about. */
  question: string;
  /** The language the words in the question belong to. */
  from: string;
  /** The language the answer is written in. */
  to: string;
  up: number;
  down: number;
  /** When the most recent vote on this answer landed, which is what "newest first" orders by. */
  lastVotedAt: Date;
}

/**
 * Every explanation a reader has voted down, worst-hit first by recency.
 *
 * NEWEST FIRST MEANS NEWEST VOTE, NOT NEWEST ANSWER. The operator is reading a
 * complaint queue: an answer written months ago that was voted down this morning
 * is the one to look at, and ordering by the ledger row's own `createdAt` would
 * bury it under freshly written rows nobody has judged.
 *
 * A ROW APPEARS AS SOON AS IT HAS ONE DOWN-VOTE, with no minimum and no score
 * threshold. Nothing automatic hangs off this list (M194 decision 8), so the
 * cost of showing a row too early is a person reading one extra line, and the
 * cost of hiding it is a signal nobody sees. The `up` count is beside it so the
 * reader can tell a disputed answer from a rejected one.
 *
 * THERE IS NO PAGED VARIANT, AND THAT IS A DECISION. The translation list has
 * one because an API endpoint serves it; this list has no endpoint and no CLI
 * command, by the governance rule in this file's header, so a second statement
 * would exist only to be called by something that must not exist.
 *
 * @param db The database handle.
 * @param limit How many rows to return.
 * @returns the answers, with their question and their direction.
 */
export async function listDownVotedExplanations(
  db: DictionaryDb,
  limit: number,
): Promise<DownVotedExplanationView[]> {
  return db
    .select({
      explanationId: explanations.id,
      question: explanations.question,
      from: explanations.fromLanguageCode,
      to: explanations.toLanguageCode,
      up: UP_COUNT,
      down: DOWN_COUNT,
      lastVotedAt: sql<Date>`max(${explanationVotes.updatedAt})`,
    })
    .from(explanationVotes)
    // ONE JOIN, ONTO THE LEDGER, AND NOTHING ELSE. Reaching further would put
    // the question and the person who asked it on the same screen.
    .innerJoin(explanations, eq(explanations.id, explanationVotes.explanationId))
    // The grouping is what removes the account column from the answer. Every
    // selected expression is either grouped or aggregated, so no row that leaves
    // this statement can be traced back to one reader.
    .groupBy(explanations.id, explanations.question, explanations.fromLanguageCode, explanations.toLanguageCode)
    .having(sql`count(*) filter (where ${explanationVotes.value} = -1) > 0`)
    .orderBy(desc(sql`max(${explanationVotes.updatedAt})`))
    .limit(limit);
}
