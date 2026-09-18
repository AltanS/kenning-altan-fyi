/**
 * The explain ledger: every attempt to have a model answer one question about
 * words, and the structured answer the successful ones carry.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *   The same rule the dictionary queries, the run ledger and the phrase ledger
 *   follow, for the same reason: `drizzle/db.ts` opens a connection pool at
 *   module load, and this module is reached from three directions, a route
 *   loader holding `getRawDb()`, a workflow handler, and the unit tier, which
 *   has no database at all. Only the TYPE is imported, so importing this file
 *   opens nothing.
 *
 * A ROW IS BOTH THE RUN RECORD AND THE CACHE, exactly as `phrase_translations`
 * is. `latestExplanationAnswer` is the cache read, and it is asked FIRST, before
 * the state read, so a newer failed attempt cannot hide an answer that already
 * exists.
 *
 * THE ANSWER IS PARSED ON THE WAY OUT, NOT ASSERTED.
 *   The column is `jsonb`, so Drizzle hands back an unknown document. Asserting
 *   `Explanation` onto it would mean one bad row, written by an older prompt
 *   version or repaired by hand, renders as a card with undefined fields in it.
 *   `explanationSchema.safeParse` is the boundary instead: a row that does not
 *   decode is treated as an answer this installation cannot show, which the
 *   resolver reads as "nothing is coming" and the trigger half may then queue
 *   afresh.
 *
 * IT HOLDS NO READER. No account id, no session id, no device id, and no
 * function here takes one. See the header of `drizzle/schema/explanations.ts`.
 */

import { and, count, desc, eq, gte, inArray, or } from 'drizzle-orm';
import { z } from 'zod';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { JsonValue } from '#app/lib/json';
import { explanationSchema, type Explanation } from '#app/lib/llm/explain-schema';
import { createComponentLogger } from '#app/lib/logger';
import { explanations } from '#drizzle/schema';

const log = createComponentLogger('explanations');

/**
 * The four states an explanation row can be in.
 *
 * `pending` is written by the request that enqueued the job, before the enqueue
 * returns. Everything else is terminal and is written exactly once, by the job.
 * `budget` is separated from `failed` because the two mean opposite things to a
 * reader: one is "come back tomorrow", the other is "try again".
 */
export const EXPLAIN_STATUSES = ['pending', 'ok', 'failed', 'budget'] as const;

/** One explanation row's state. See `EXPLAIN_STATUSES`. */
export type ExplainStatus = (typeof EXPLAIN_STATUSES)[number];

/** One explanation row, as the resolver and the job read it. */
export interface ExplanationView {
  id: string;
  from: string;
  to: string;
  question: string;
  questionNormalized: string;
  status: ExplainStatus;
  /** The parsed document, on an `ok` row whose stored answer still decodes. Null otherwise. */
  answer: Explanation | null;
  provider: string;
  model: string;
  promptVersion: number;
  /** USD, or null when neither pricing source could put a number on the call. */
  costUsd: number | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** The columns every read in this file selects, so the views cannot drift apart. */
const EXPLANATION_COLUMNS = {
  id: explanations.id,
  from: explanations.fromLanguageCode,
  to: explanations.toLanguageCode,
  question: explanations.question,
  questionNormalized: explanations.questionNormalized,
  status: explanations.status,
  answer: explanations.answer,
  provider: explanations.provider,
  model: explanations.model,
  promptVersion: explanations.promptVersion,
  costUsd: explanations.costUsd,
  latencyMs: explanations.latencyMs,
  error: explanations.error,
  createdAt: explanations.createdAt,
  finishedAt: explanations.finishedAt,
};

/**
 * One selected row, before the three conversions below are applied.
 *
 * Written out rather than inferred from `EXPLANATION_COLUMNS`, so the places
 * that differ from `ExplanationView` are visible: `status` is still a plain
 * string here, `costUsd` is still the `numeric` column's string, and `answer` is
 * still an undecoded document.
 */
interface ExplanationRow {
  id: string;
  from: string;
  to: string;
  question: string;
  questionNormalized: string;
  status: string;
  answer: JsonValue | null;
  provider: string;
  model: string;
  promptVersion: number;
  costUsd: string | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/**
 * The status text, narrowed.
 *
 * The check constraint on the table is what makes this total, and the fallback
 * is `failed` rather than a throw: a status the constraint somehow let through
 * must not take down a pane, and `failed` is the reading that stops one waiting
 * forever.
 */
function toStatus(value: string): ExplainStatus {
  const parsed = z.enum(EXPLAIN_STATUSES).safeParse(value);
  if (parsed.success) return parsed.data;
  log.warn('An explanation row carries a status the code does not know', { status: value });
  return 'failed';
}

/**
 * The stored document, decoded, or null when it is absent or does not decode.
 *
 * IT TAKES `JsonValue`, NOT `unknown`, WHICH IS WHY THE COLUMN IS `$type`d. A
 * bare `jsonb` column selects as `unknown`, and a function taking one either
 * asserts a shape onto it or leaves its input unparsed. The column says what a
 * jsonb column holds, and the parse below turns that into a domain value.
 *
 * A ROW THAT DOES NOT DECODE IS NOT AN ANSWER. It is treated as an `ok` row with
 * nothing in it, which the resolver reads as `none`: the reader sees the screen
 * for a question nobody has asked yet and the guards decide whether to ask
 * again. Rendering an undecodable document would put undefined fields on a card.
 *
 * EXPORTED FOR THE PUBLIC BROWSE MODEL, which selects the column itself and must
 * drop a row by the SAME rule. A second decode there would be a second reading
 * of what counts as an answer, and the private page and the public one would
 * disagree about the same row.
 */
export function toAnswer(value: JsonValue | null, id: string): Explanation | null {
  if (value === null) return null;
  const parsed = explanationSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log.warn('An explanation row carries an answer this version cannot read', { id });
  return null;
}

/**
 * `numeric` arrives as a string, and the conversion happens here, once.
 *
 * Postgres `numeric` holds values a JavaScript number cannot represent exactly,
 * so Drizzle carries the column as a string in both directions. This module is
 * the boundary where that string becomes a number, the same way
 * `app/models/phrase-runs.server.ts` is the boundary for its own column.
 */
function toCostUsd(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toView(row: ExplanationRow): ExplanationView {
  return {
    ...row,
    status: toStatus(row.status),
    answer: toAnswer(row.answer, row.id),
    costUsd: toCostUsd(row.costUsd),
  };
}

/** Everything a pending explanation row needs at the moment a reader asks. */
export interface InsertPendingExplanationParams {
  from: LanguageCode;
  to: LanguageCode;
  /** As typed, trimmed. It is what the model is shown. */
  question: string;
  /** The folded form, which is the cache key. */
  questionNormalized: string;
  promptVersion: number;
  provider: string;
  model: string;
}

/**
 * Open an explanation row, `pending`, before the job is queued.
 *
 * WRITTEN FIRST, ON PURPOSE. The pane resolves its state from the latest row for
 * a key, so a job queued with no row behind it leaves a reader looking at
 * nothing while a model is already answering, and a reload enqueues again. The
 * row is the promise that something is happening.
 *
 * @param db The database handle.
 * @param params The question, the two languages, the prompt version, and the
 *   model that is about to be asked. The model is recorded here rather than by
 *   the job, so the row names the selection at the moment the reader asked even
 *   if an operator switches models while the job waits.
 * @returns The new row's id, which becomes the job payload's `runId`.
 * @throws If the insert returns no row, which would mean a job whose every exit
 *   path writes to an id nothing holds.
 */
export async function insertPendingExplanation(
  db: DictionaryDb,
  params: InsertPendingExplanationParams,
): Promise<string> {
  const [row] = await db
    .insert(explanations)
    .values({
      fromLanguageCode: params.from,
      toLanguageCode: params.to,
      question: params.question,
      questionNormalized: params.questionNormalized,
      promptVersion: params.promptVersion,
      provider: params.provider,
      model: params.model,
      status: 'pending',
    })
    .returning({ id: explanations.id });

  if (!row) throw new Error('Failed to open an explanation row');
  return row.id;
}

/** Which rows to read: one direction, one folded question. */
export interface ExplanationKey {
  from: LanguageCode;
  to: LanguageCode;
  questionNormalized: string;
}

/**
 * The same three parts, with the languages as plain strings.
 *
 * IT EXISTS FOR THE ROWS THAT CAME BACK OUT OF A TABLE. Both direction columns
 * are `text` on purpose, here and on `explanation_asks`, so a row written while
 * a language was served stays readable after it is withdrawn. A caller holding
 * such a row has two strings and no way to prove they are still served, and
 * narrowing them just to look one up would be a check with nothing behind it:
 * the query is an equality test on a text column either way.
 */
export interface ExplanationKeyParts {
  from: string;
  to: string;
  questionNormalized: string;
}

/** The three conditions every read below shares. */
function keyCondition(key: ExplanationKeyParts) {
  return and(
    eq(explanations.fromLanguageCode, key.from),
    eq(explanations.toLanguageCode, key.to),
    eq(explanations.questionNormalized, key.questionNormalized),
  );
}

/**
 * The newest ANSWERED row for one key, or null when there is none.
 *
 * THIS IS THE CACHE READ, AND IT IS THE ONE THAT MAKES THE SECOND READER FREE.
 * It is asked before the state read, so a later failed attempt cannot hide an
 * answer this installation has already paid for.
 */
export async function latestExplanationAnswer(db: DictionaryDb, key: ExplanationKey): Promise<ExplanationView | null> {
  const rows = await db
    .select(EXPLANATION_COLUMNS)
    .from(explanations)
    .where(and(keyCondition(key), eq(explanations.status, 'ok')))
    .orderBy(desc(explanations.createdAt))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/**
 * The newest row for one key whatever its status, or null when there is none.
 *
 * THE LATEST ROW IS THE STATE, and that is the whole reason this table is append
 * only. A failed run followed by a retry leaves two rows, and the reader's pane
 * must show the retry. Ordering on `created_at` desc is served by
 * `explanations_latest_idx`.
 */
export async function latestExplanation(db: DictionaryDb, key: ExplanationKey): Promise<ExplanationView | null> {
  const rows = await db
    .select(EXPLANATION_COLUMNS)
    .from(explanations)
    .where(keyCondition(key))
    .orderBy(desc(explanations.createdAt))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/** One row by id, or null. The job body starts here. */
export async function getExplanation(db: DictionaryDb, id: string): Promise<ExplanationView | null> {
  const rows = await db.select(EXPLANATION_COLUMNS).from(explanations).where(eq(explanations.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/** How an explain run ends. Every field but `status` is optional, because a refused run has almost none of them. */
export interface SettleExplanationParams {
  status: Exclude<ExplainStatus, 'pending'>;
  /** The parsed document. Only ever passed with `ok`. */
  answer?: Explanation;
  error?: string;
  costUsd?: number | null;
  latencyMs?: number;
}

/** The columns one terminal write sets. The shape `settleExplanation` hands to `.set()`. */
export interface ExplanationTerminalValues {
  status: Exclude<ExplainStatus, 'pending'>;
  /** Always written, and null on a run that ended without one. See `explanationTerminalValues`. */
  error: string | null;
  finishedAt: Date;
  answer?: JsonValue;
  costUsd?: string | null;
  latencyMs?: number;
}

/**
 * What a terminal write sets, as a value, so the shape can be asserted without a
 * database.
 *
 * `error` IS ALWAYS WRITTEN, AND THAT IS THE POINT OF THIS FUNCTION. It used to
 * be set only when the caller passed one, which left the previous attempt's
 * message sitting beside a good answer: pg-boss retries a timed-out job on the
 * SAME row, so a run that timed out and then succeeded ended as
 * `status = 'ok'` carrying `error = 'Request timed out after 90019ms'`. Every
 * operator surface that reads the column then reports a failure that did not
 * happen. A terminal write describes how the run ended, so a run that ended with
 * no error says so rather than saying nothing.
 *
 * @param params How the run ended.
 * @param finishedAt When it ended. Passed rather than read, so a test can name
 *   the instant.
 */
export function explanationTerminalValues(
  params: SettleExplanationParams,
  finishedAt: Date,
): ExplanationTerminalValues {
  return {
    status: params.status,
    error: params.error ?? null,
    finishedAt,
    ...(params.answer !== undefined && { answer: params.answer }),
    // `costUsd` is threaded through even when it is null, because null is a
    // real answer here: it means the call ran and nothing could price it.
    ...(params.costUsd !== undefined && { costUsd: params.costUsd === null ? null : params.costUsd.toFixed(6) }),
    ...(params.latencyMs !== undefined && { latencyMs: params.latencyMs }),
  };
}

/**
 * Write an explanation row's terminal status.
 *
 * THE ONE UPDATE THIS TABLE ALLOWS, and the job calls it on EVERY exit path,
 * including the ones an exception takes. A row left `pending` is a reader
 * watching a spinner that will never stop, and no timeout anywhere would clear
 * it: nothing else in the system knows the job is gone.
 */
export async function settleExplanation(
  db: DictionaryDb,
  id: string,
  params: SettleExplanationParams,
): Promise<void> {
  await db
    .update(explanations)
    .set(explanationTerminalValues(params, new Date()))
    .where(eq(explanations.id, id));
}

/**
 * Drop a pending row that no job will ever finish.
 *
 * THE DEDUPE PATH, AND NOTHING ELSE CALLS IT. The enqueue opens the row before
 * it queues, so a request that turns out to be a duplicate has already written
 * one. Leaving it `pending` would give the pane a run nobody is working on;
 * marking it `failed` would be worse, because the pane reads the LATEST row and
 * would then show a failure while the real job, whose row is older, is still
 * running. Removing it puts the truth back.
 */
export async function deletePendingExplanation(db: DictionaryDb, id: string): Promise<void> {
  await db.delete(explanations).where(and(eq(explanations.id, id), eq(explanations.status, 'pending')));
}

/**
 * How many explain runs this installation has started today, UTC.
 *
 * `pending` AND `ok`, NOT `failed`. The count is what `MAX_EXPLAIN_RUNS_PER_DAY`
 * bounds, and that cap exists to bound how many paid calls a day can make. A
 * failed run produced no answer, so charging the day for it would let a provider
 * outage lock the feature out for everyone. A `pending` run DOES count: it is
 * about to call. `budget` rows are excluded for the same reason as `failed`: a
 * run refused by a cap must not itself consume the cap, or the first refusal of
 * the day would push every later one further out of reach.
 *
 * @param db The database handle.
 * @param at The instant whose UTC day to count. Passed rather than read so the
 *   arithmetic is testable, the same rule `app/lib/abuse/budget.server.ts` uses.
 */
export async function countExplainRunsToday(db: DictionaryDb, at: Date = new Date()): Promise<number> {
  const startOfDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const [row] = await db
    .select({ total: count() })
    .from(explanations)
    .where(and(gte(explanations.createdAt, startOfDay), inArray(explanations.status, ['pending', 'ok'])));
  return row?.total ?? 0;
}

/**
 * The most recent explanation rows, newest first.
 *
 * THE OPERATOR'S HALF, the same question `listPhraseRuns` answers for a
 * sentence. There are three run tables now, and an operator asking "what did we
 * spend on" wants all of them.
 *
 * @param db The database handle.
 * @param limit How many rows to return.
 */
export async function listExplainRuns(db: DictionaryDb, limit: number): Promise<ExplanationView[]> {
  const rows = await db
    .select(EXPLANATION_COLUMNS)
    .from(explanations)
    .orderBy(desc(explanations.createdAt))
    .limit(limit);
  return rows.map(toView);
}

/**
 * A key as one string, so a list screen can look its rows up in a map.
 *
 * `JSON.stringify` OVER A JOIN, because a question may contain any character at
 * all, including whatever separator a join would pick. An encoding that can be
 * ambiguous eventually is, and the collision would show one reader's row under
 * another question.
 *
 * @param key One direction and one folded question.
 * @returns The map key.
 */
export function explanationKeyString(key: ExplanationKeyParts): string {
  return JSON.stringify([key.from, key.to, key.questionNormalized]);
}

/** Where one question stands, as a list screen needs to say it in one line. */
export interface ExplanationStanding {
  /** The latest row's status, or `ok` whenever a readable answer exists at all. */
  status: ExplainStatus;
  /** The answer, when this installation holds one it can still read. */
  answer: Explanation | null;
}

/**
 * Where each of many questions stands, in two queries rather than two per row.
 *
 * IT IS `resolveExplainPanel`'S PRECEDENCE, APPLIED IN BULK. The answered read
 * wins over the state read, so a failed retry cannot hide an answer this
 * installation has already paid for. That is the rule the pane follows, and the
 * rule the detail page will follow when the reader opens the row: a list that
 * disagreed with the page it links to would be worse than a list with no
 * preview on it at all.
 *
 * `DISTINCT ON` IS WHAT KEEPS THIS TO TWO QUERIES. Postgres returns the first
 * row of each group under the stated order, so ordering by the three key columns
 * and then `created_at desc` yields the latest row per key directly.
 *
 * AN EMPTY KEY LIST IS ANSWERED WITHOUT A QUERY, and that is a correctness guard
 * rather than an optimisation: `or()` over nothing is undefined, which would
 * drop the WHERE clause and read the whole table.
 *
 * @param db The database handle.
 * @param keys The questions on one page.
 * @returns A map from `explanationKeyString` to where that question stands. A
 *   key nothing has ever been written for is absent from the map.
 */
export async function explanationStandings(
  db: DictionaryDb,
  keys: readonly ExplanationKeyParts[],
): Promise<Map<string, ExplanationStanding>> {
  const standings = new Map<string, ExplanationStanding>();
  if (keys.length === 0) return standings;

  const groupBy = [explanations.fromLanguageCode, explanations.toLanguageCode, explanations.questionNormalized];
  const anyKey = or(...keys.map(keyCondition));

  const [latest, answered] = await Promise.all([
    db
      .selectDistinctOn(groupBy, EXPLANATION_COLUMNS)
      .from(explanations)
      .where(anyKey)
      .orderBy(...groupBy, desc(explanations.createdAt)),
    db
      .selectDistinctOn(groupBy, EXPLANATION_COLUMNS)
      .from(explanations)
      .where(and(anyKey, eq(explanations.status, 'ok')))
      .orderBy(...groupBy, desc(explanations.createdAt)),
  ]);

  for (const row of latest.map(toView)) {
    standings.set(explanationKeyString(row), { status: row.status, answer: row.answer });
  }
  // SECOND, SO IT WINS. An answered row is the answer whatever a later attempt
  // did.
  for (const row of answered.map(toView)) {
    if (row.answer === null) continue;
    standings.set(explanationKeyString(row), { status: 'ok', answer: row.answer });
  }

  return standings;
}
