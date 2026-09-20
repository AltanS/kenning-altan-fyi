/**
 * Rejections of one generated translation run, and the cooldown that stands
 * between a rejection and a second paid re-run.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT. The same rule
 * `app/models/translation-votes.server.ts` follows, for the same reason:
 * `drizzle/db.ts` opens a connection pool at module load, and this module is
 * reached from a route action holding `getRawDb()`. Only the TYPE is imported,
 * so importing this file opens nothing.
 *
 * EVERY TABLE HERE IS SHARED. A run, a rejection and a cooldown row all
 * describe the one dictionary this installation serves, so `getRawDb()` is the
 * correct handle and no filter narrows these statements to a reader.
 *
 * THE PRIVACY RULE THAT SHAPES THE WRITES. The account id enters exactly one
 * statement in this file, the insert into `translation_rejections`, and it is
 * never selected, never filtered on and never grouped by. `countRejections`
 * reads the SIGNAL table, which carries no reader at all, so nothing an
 * operator or a screen can call from here holds an account id and a word at the
 * same time. `drizzle/schema/translation-feedback.ts` argues why that split is
 * the feature rather than a detail.
 */

import { and, count, eq } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { RejectionReason } from '#app/lib/translation/rejection';
import { retranslationLog, translationRejectionSignals, translationRejections } from '#drizzle/schema';

/**
 * The cooldown predicate, re-exported so a server caller that already holds
 * this module does not have to reach for a second one. It is declared in
 * `app/lib/translation/rejection.ts`, which the browser also reads, and it must
 * stay there: that module imports nothing, so it cannot drag Drizzle into the
 * client bundle.
 */
export { isRetranslationCooldownActive } from '#app/lib/translation/rejection';

/** One reader's rejection of one run, as the route action supplies it. */
export interface RecordRejectionParams {
  runId: string;
  accountId: number;
  reason: RejectionReason;
}

/** One (headword, direction) pair, which is the grain the cooldown is kept at. */
export interface RetranslationCooldownKey {
  headwordId: string;
  from: string;
  to: string;
}

/**
 * Record one reader's rejection of one run, and its reason code.
 *
 * TWO ROWS IN ONE TRANSACTION, and they are two rows because the fact and the
 * content are kept apart: see the header of
 * `drizzle/schema/translation-feedback.ts`. A partial write would leave either
 * a reader with no complaint or a complaint nobody can be stopped from
 * repeating, so the pair is atomic.
 *
 * THE SIGNAL IS APPENDED ONLY WHEN THE FACT ROW WAS GENUINELY NEW, and that is
 * the whole reason this function reports back. The signals table is the corpus
 * TALLY: one reader pressing the button twice would put two rows in it, and a
 * later read of that tally would say two people agreed. `onConflictDoNothing`
 * on the composite primary key is what makes the second press a no-op, and the
 * empty `returning()` is how this function knows it was one.
 *
 * @param db The database handle.
 * @param params The run, the reader, and the reason code.
 * @returns `firstTime: false` when this reader had already rejected this run,
 *   so the caller can decide whether a re-run is worth ordering. A repeat press
 *   must never order one.
 */
export async function recordRejection(
  db: DictionaryDb,
  params: RecordRejectionParams,
): Promise<{ firstTime: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(translationRejections)
      .values({ runId: params.runId, accountId: params.accountId })
      .onConflictDoNothing({ target: [translationRejections.runId, translationRejections.accountId] })
      .returning({ runId: translationRejections.runId });

    if (inserted.length === 0) return { firstTime: false };

    await tx.insert(translationRejectionSignals).values({ runId: params.runId, reason: params.reason });
    return { firstTime: true };
  });
}

/**
 * How many rejections one run has collected.
 *
 * IT COUNTS THE SIGNAL ROWS, NOT THE FACT ROWS, and the choice is deliberate
 * rather than arbitrary: the two counts are always equal, because
 * {@link recordRejection} writes one signal per new fact, and this is the read
 * that may be made anywhere. Counting the fact table would put a statement over
 * the account column on a path any screen can call.
 *
 * @param db The database handle.
 * @param runId The run to count complaints about.
 * @returns the count, `0` when nobody has rejected the run.
 */
export async function countRejections(db: DictionaryDb, runId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(translationRejectionSignals)
    .where(eq(translationRejectionSignals.runId, runId));

  return Number(row?.value ?? 0);
}

/**
 * When a re-translation was last queued for one (headword, direction) pair.
 *
 * @param db The database handle.
 * @param key The headword and the direction a re-run would cost money for.
 * @returns the instant, or `null` when the pair has never been re-run. `null`
 *   means "nothing to wait for", which is what
 *   `isRetranslationCooldownActive` reads it as.
 */
export async function readRetranslationCooldown(
  db: DictionaryDb,
  key: RetranslationCooldownKey,
): Promise<Date | null> {
  const [row] = await db
    .select({ lastQueuedAt: retranslationLog.lastQueuedAt })
    .from(retranslationLog)
    .where(
      and(
        eq(retranslationLog.headwordId, key.headwordId),
        eq(retranslationLog.fromLanguageCode, key.from),
        eq(retranslationLog.toLanguageCode, key.to),
      ),
    )
    .limit(1);

  return row?.lastQueuedAt ?? null;
}

/**
 * Move one pair's cooldown cursor to now.
 *
 * AN UPSERT, AND THE ROW IS A CURSOR RATHER THAN A HISTORY. `last_queued_at` is
 * overwritten on every queued re-run: the table answers "may this pair be
 * re-run right now" and nothing else, so the previous instant is of no use to
 * anybody and keeping it would turn a three-column table into a log of when
 * each word was complained about.
 *
 * @param db The database handle.
 * @param key The headword and the direction that was just queued.
 */
export async function touchRetranslationCooldown(db: DictionaryDb, key: RetranslationCooldownKey): Promise<void> {
  await db
    .insert(retranslationLog)
    .values({ headwordId: key.headwordId, fromLanguageCode: key.from, toLanguageCode: key.to })
    .onConflictDoUpdate({
      target: [retranslationLog.headwordId, retranslationLog.fromLanguageCode, retranslationLog.toLanguageCode],
      // Moved explicitly. `defaultNow()` applies to the INSERT, and a conflict
      // that took no `set` would leave the cursor frozen at the first re-run,
      // which is a cooldown that expires once and never again.
      set: { lastQueuedAt: new Date() },
    });
}
