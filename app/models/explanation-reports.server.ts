/**
 * A reader flagging one public answer (M200).
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT, the same rule every model beside
 * this one follows.
 *
 * THERE IS ONE WRITE HERE AND NO READ AT ALL. The operator's queue reads the
 * table through `app/models/explanation-moderation.server.ts`, grouped to the
 * question, so the reporter's own column is never selected anywhere. This module
 * offers no "what has this reader reported" path and must never grow one: it is
 * the same governance the vote table carries, for the same reason, because a row
 * here permanently links one account to one free-text question.
 *
 * NOTHING HERE LOGS.
 */

import { eq } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { explanationReports } from '#drizzle/schema';

/** One report, as the page's own action sends it. */
export interface RecordExplanationReportParams {
  /** The answer on screen. It is public, so accepting it from the client is safe: nothing is owned by anyone here. */
  explanationId: string;
  accountId: number;
  /** What the reader said is wrong, trimmed, or null when they sent nothing. */
  reason: string | null;
}

/**
 * Records one reader's report on one answer, replacing their previous one.
 *
 * THE UPSERT IS THE "ONE REPORT PER READER PER ANSWER" RULE, and the target is
 * the unique index on `(explanation_id, account_id)`. A plain insert would stack
 * rows, and the operator's count would count clicks instead of people.
 *
 * `createdAt` MOVES ON A REPEAT, deliberately: the queue is ordered by the
 * newest complaint, and a reader coming back to say the same thing again is
 * saying it again now.
 *
 * @param db The database handle.
 * @param params The answer, the reader, and what they said.
 */
export async function recordExplanationReport(db: DictionaryDb, params: RecordExplanationReportParams): Promise<void> {
  await db
    .insert(explanationReports)
    .values({
      explanationId: params.explanationId,
      accountId: params.accountId,
      reason: params.reason,
    })
    .onConflictDoUpdate({
      target: [explanationReports.explanationId, explanationReports.accountId],
      set: { reason: params.reason, createdAt: new Date() },
    });
}

/**
 * How many reports one answer carries.
 *
 * IT COUNTS AND RETURNS NOTHING ELSE, so there is no caller that could read a
 * reporter off it. It exists for the tests that have to prove a refused report
 * wrote nothing.
 *
 * @param db The database handle.
 * @param explanationId The answer.
 */
export async function countExplanationReports(db: DictionaryDb, explanationId: string): Promise<number> {
  const rows = await db
    .select({ id: explanationReports.id })
    .from(explanationReports)
    .where(eq(explanationReports.explanationId, explanationId));

  return rows.length;
}
