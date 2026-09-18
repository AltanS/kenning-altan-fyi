/**
 * The operator's half of the public pages: what has been reported, and what has
 * been taken down (M200).
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT, the same rule every model beside
 * this one follows.
 *
 * A HIDE IS KEYED ON THE QUESTION, NOT ON ONE ROW. `drizzle/schema/explanation-moderation.ts`
 * carries the argument in full: the ledger is append only, so a per-row flag is
 * lost the moment a newer answered row opens under the same key and the question
 * is published again with nobody deciding that. Every write here therefore takes
 * the triple, and the operator screen resolves the row it is looking at back to
 * its triple before it calls one.
 *
 * THE QUEUE NAMES THE QUESTION AND NEVER THE PERSON. It joins the ledger, the
 * reports and the votes, and it joins neither the authorship table nor the
 * profile table. The reporter's own account column is never selected: an
 * operator triaging a complaint must not also learn who complained, and must not
 * learn who asked. Adding either join, or that column, would defeat both claims
 * at once with no other change.
 *
 * NOTHING HERE LOGS. The rows hold free text a person typed.
 */

import { and, desc, eq, or, sql } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { explanationKeyString } from '#app/models/explanations.server';
import { explanationModeration, explanationReports, explanationVotes, explanations } from '#drizzle/schema';

/** The three columns one question is identified by. */
export interface ModerationKey {
  from: string;
  to: string;
  questionNormalized: string;
}

/** One question in the operator's queue. */
export interface ModerationQueueEntry {
  /** The latest ledger row for this question. The form carries it and the action resolves it back to the key. */
  explanationId: string;
  question: string;
  /** The language the words in the question belong to. */
  from: string;
  /** The language the answer is written in. */
  to: string;
  /** The tally of the latest ANSWERED row, which is the one the public pages serve. */
  up: number;
  down: number;
  /** How many reports the question has collected across every row it ever opened. */
  reportCount: number;
  /** What the newest report said, or null when it said nothing or there is none. */
  lastReportReason: string | null;
  /** Whether a moderation row exists for this question right now. */
  hidden: boolean;
}

/** What one hide records. */
export interface HideQuestionParams {
  from: string;
  to: string;
  questionNormalized: string;
  /** Which operator decided. Kept even after their account is gone, as null. */
  hiddenByUserId: number;
  /** Why, in the operator's own words. Never shown to a reader. */
  reason: string | null;
}

/**
 * Takes one question off the public pages.
 *
 * `onConflictDoNothing` RATHER THAN AN UPSERT, because the row's PRESENCE is the
 * whole state. Hiding something already hidden is a no-op, and overwriting the
 * original `hidden_at` would lose when the decision was actually taken.
 *
 * @param db The database handle.
 * @param params The question, who decided, and why.
 */
export async function hideQuestion(db: DictionaryDb, params: HideQuestionParams): Promise<void> {
  await db
    .insert(explanationModeration)
    .values({
      fromLanguageCode: params.from,
      toLanguageCode: params.to,
      questionNormalized: params.questionNormalized,
      hiddenByUserId: params.hiddenByUserId,
      reason: params.reason,
    })
    .onConflictDoNothing();
}

/** Which question to put back. */
export interface UnhideQuestionParams {
  from: string;
  to: string;
  questionNormalized: string;
}

/**
 * Puts one question back on the public pages.
 *
 * A DELETE, NOT A FLAG. No row means visible, so there is no third state for a
 * listing query to read wrongly.
 *
 * @param db The database handle.
 * @param params The question.
 */
export async function unhideQuestion(db: DictionaryDb, params: UnhideQuestionParams): Promise<void> {
  await db
    .delete(explanationModeration)
    .where(
      and(
        eq(explanationModeration.fromLanguageCode, params.from),
        eq(explanationModeration.toLanguageCode, params.to),
        eq(explanationModeration.questionNormalized, params.questionNormalized),
      ),
    );
}

/**
 * The question one ledger row answers.
 *
 * THE OPERATOR'S FORM CARRIES A ROW ID AND THE WRITE NEEDS A KEY, so the two are
 * bridged here, server side, on every submission. The form cannot send a key
 * directly: a hand-edited one would hide a question the operator never looked at.
 *
 * @param db The database handle.
 * @param explanationId The row the form named.
 * @returns the key, or null when nothing carries that id.
 */
export async function resolveModerationKey(db: DictionaryDb, explanationId: string): Promise<ModerationKey | null> {
  const [row] = await db
    .select({
      from: explanations.fromLanguageCode,
      to: explanations.toLanguageCode,
      questionNormalized: explanations.questionNormalized,
    })
    .from(explanations)
    .where(eq(explanations.id, explanationId))
    .limit(1);

  return row ?? null;
}

/** The three key columns, in the order every DISTINCT ON below walks them. */
const KEY_COLUMNS = [explanations.fromLanguageCode, explanations.toLanguageCode, explanations.questionNormalized];

/** The condition matching exactly the questions in one list. */
function anyOfKeys(keys: readonly ModerationKey[]) {
  return or(
    ...keys.map((key) =>
      and(
        eq(explanations.fromLanguageCode, key.from),
        eq(explanations.toLanguageCode, key.to),
        eq(explanations.questionNormalized, key.questionNormalized),
      ),
    ),
  );
}

/** One question's report figures, as the queue read collects them. */
interface ReportedKey extends ModerationKey {
  reportCount: number;
  lastReportReason: string | null;
  lastReportAt: Date;
}

/**
 * Every reported question, newest report first.
 *
 * ONE STATEMENT, AND THE COUNT IS A WINDOW. Postgres computes window functions
 * before `DISTINCT ON` drops the rows, so the partitioned count sees every
 * report for a question while the row that survives is the newest one, which is
 * where the reason comes from.
 */
async function listReportedKeys(db: DictionaryDb, limit: number): Promise<ReportedKey[]> {
  const perKey = db
    .selectDistinctOn(KEY_COLUMNS, {
      from: explanations.fromLanguageCode,
      to: explanations.toLanguageCode,
      questionNormalized: explanations.questionNormalized,
      lastReportReason: explanationReports.reason,
      lastReportAt: explanationReports.createdAt,
      reportCount:
        sql<number>`count(*) over (partition by ${explanations.fromLanguageCode}, ${explanations.toLanguageCode}, ${explanations.questionNormalized})`.as(
          'report_count',
        ),
    })
    .from(explanationReports)
    .innerJoin(explanations, eq(explanations.id, explanationReports.explanationId))
    .orderBy(...KEY_COLUMNS, desc(explanationReports.createdAt))
    .as('reported_questions');

  const rows = await db
    .select({
      from: perKey.from,
      to: perKey.to,
      questionNormalized: perKey.questionNormalized,
      lastReportReason: perKey.lastReportReason,
      lastReportAt: perKey.lastReportAt,
      reportCount: sql<number>`${perKey.reportCount}`.mapWith(Number),
    })
    .from(perKey)
    .orderBy(desc(perKey.lastReportAt))
    .limit(limit);

  return rows;
}

/**
 * The operator's queue: every question carrying a report or a hide.
 *
 * A QUESTION WITH NO LEDGER ROW LEFT DROPS OUT, which is why every read below
 * starts from `explanations`. A hide over a key whose rows are all gone hides
 * nothing and there is no row for the form to name.
 *
 * @param db The database handle.
 * @param limit How many questions to show.
 */
export async function listModerationQueue(db: DictionaryDb, limit: number): Promise<ModerationQueueEntry[]> {
  const [reported, hiddenRows] = await Promise.all([
    listReportedKeys(db, limit),
    db
      .select({
        from: explanationModeration.fromLanguageCode,
        to: explanationModeration.toLanguageCode,
        questionNormalized: explanationModeration.questionNormalized,
        hiddenAt: explanationModeration.hiddenAt,
      })
      .from(explanationModeration)
      .orderBy(desc(explanationModeration.hiddenAt))
      .limit(limit),
  ]);

  const hiddenKeys = new Set(hiddenRows.map((row) => explanationKeyString(row)));
  const keys = new Map<string, ModerationKey>();
  for (const row of [...reported, ...hiddenRows]) {
    keys.set(explanationKeyString(row), {
      from: row.from,
      to: row.to,
      questionNormalized: row.questionNormalized,
    });
  }
  if (keys.size === 0) return [];
  const keyList = [...keys.values()];

  const tally = db
    .select({
      explanationId: explanationVotes.explanationId,
      up: sql<number>`count(*) filter (where ${explanationVotes.value} = 1)`.as('up'),
      down: sql<number>`count(*) filter (where ${explanationVotes.value} = -1)`.as('down'),
    })
    .from(explanationVotes)
    .groupBy(explanationVotes.explanationId)
    .as('explanation_tally');

  const [latestRows, answeredRows] = await Promise.all([
    // The question itself comes from the latest row of ANY status: a question
    // whose only answered row has since been superseded by a failed retry still
    // has to be readable here.
    db
      .selectDistinctOn(KEY_COLUMNS, {
        from: explanations.fromLanguageCode,
        to: explanations.toLanguageCode,
        questionNormalized: explanations.questionNormalized,
        explanationId: explanations.id,
        question: explanations.question,
      })
      .from(explanations)
      .where(anyOfKeys(keyList))
      .orderBy(...KEY_COLUMNS, desc(explanations.createdAt)),
    // The tally is the LATEST ANSWERED row's, because that is the row the public
    // pages serve and therefore the one readers voted on.
    db
      .selectDistinctOn(KEY_COLUMNS, {
        from: explanations.fromLanguageCode,
        to: explanations.toLanguageCode,
        questionNormalized: explanations.questionNormalized,
        up: sql<number>`coalesce(${tally.up}, 0)`.mapWith(Number),
        down: sql<number>`coalesce(${tally.down}, 0)`.mapWith(Number),
      })
      .from(explanations)
      .leftJoin(tally, eq(tally.explanationId, explanations.id))
      .where(and(eq(explanations.status, 'ok'), anyOfKeys(keyList)))
      .orderBy(...KEY_COLUMNS, desc(explanations.createdAt)),
  ]);

  const tallies = new Map(answeredRows.map((row) => [explanationKeyString(row), row]));
  const reports = new Map(reported.map((row) => [explanationKeyString(row), row]));

  /** When this question was last complained about, or 0 when it never was. */
  function reportedAt(row: ModerationKey): number {
    return reports.get(explanationKeyString(row))?.lastReportAt.getTime() ?? 0;
  }

  // Newest complaint first, and the questions nobody has reported after them:
  // this is a triage list, so the thing somebody just objected to leads it.
  return latestRows
    .toSorted((left, right) => reportedAt(right) - reportedAt(left))
    .slice(0, limit)
    .map((row) => {
      const key = explanationKeyString(row);
      const report = reports.get(key);
      return {
        explanationId: row.explanationId,
        question: row.question,
        from: row.from,
        to: row.to,
        up: tallies.get(key)?.up ?? 0,
        down: tallies.get(key)?.down ?? 0,
        reportCount: report?.reportCount ?? 0,
        lastReportReason: report?.lastReportReason ?? null,
        hidden: hiddenKeys.has(key),
      };
    });
}
