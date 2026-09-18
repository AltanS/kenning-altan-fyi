/**
 * Authorship rows: who caused one explanation to be written, and what they
 * chose to show beside it (M200).
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT. The same rule
 * `app/models/user-profiles.server.ts` and `app/models/votes.server.ts` follow,
 * and here it is load-bearing rather than tidy: the insert below runs inside the
 * transaction `enqueueExplain` opens around the ledger row it names, so the
 * handle it is given is a transaction handle, not the pool.
 *
 * EVERY MUTATION PUTS THE READER IN THE `WHERE` CLAUSE beside the row id, the
 * shape `getExplanationAsk` states for itself. Callers are expected to have gone
 * through `resolveOwnAuthorship` first, which already proved ownership three
 * ways; this is the second check that stops a future caller who forgets.
 *
 * `resolvePublicByline` IS WHAT A SINGLE-ROW READ CALLS, and it is not the only
 * reader of a byline. The public list computes the same byline inside its own
 * SQL, joining `explanation_authorship` and `user_profiles` inline
 * (`app/models/explanation-browse.server.ts`), and an integration test pins the
 * two readings to agree on every row the list returns. The name is never copied
 * onto another row, and it is never cached anywhere: it is a join, so clearing
 * a public name in `/settings` changes what every past explanation shows at
 * once, with no per-row write and nothing to backfill.
 *
 * NOTHING HERE LOGS. This module holds an account id beside the id of a row that
 * carries free text a person typed, which is exactly the pair `explanations`
 * exists to keep apart. It writes no log line at any level.
 */
import { and, eq, inArray } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { explanationAuthorship, explanations, userProfiles } from '#drizzle/schema';

/** What one authorship write names. The row id is minted by the caller's own insert. */
export interface InsertExplanationAuthorshipParams {
  explanationId: string;
  userId: number;
  /** From the author's own `user_profiles` preference, never from a client value. */
  listed: boolean;
}

/**
 * Records who opened one explanation row.
 *
 * A PLAIN INSERT WITH NO CONFLICT HANDLING, and that is safe rather than
 * optimistic: `explanationId` is a UUID the same call just minted inside the
 * same transaction, so it cannot already be claimed.
 *
 * @param db The database handle, a transaction handle on the one path that
 *   calls this.
 * @param params The row, its author, and the visibility it starts at.
 */
export async function insertExplanationAuthorship(
  db: DictionaryDb,
  params: InsertExplanationAuthorshipParams,
): Promise<void> {
  await db.insert(explanationAuthorship).values({
    explanationId: params.explanationId,
    userId: params.userId,
    listed: params.listed,
  });
}

/** One authorship row, as the ownership check and the moderation reads see it. */
export interface AuthorshipOwner {
  userId: number;
  listed: boolean;
  showName: boolean;
}

/**
 * The authorship row for one explanation, or null when nobody claimed it.
 *
 * NULL IS AN ORDINARY ANSWER, not a missing row to repair: every explanation
 * written before this table existed has none, and so does every row a job wrote
 * for a key whose losing request was deleted.
 *
 * @param db The database handle.
 * @param explanationId The ledger row.
 */
export async function getAuthorshipOwner(db: DictionaryDb, explanationId: string): Promise<AuthorshipOwner | null> {
  const [row] = await db
    .select({
      userId: explanationAuthorship.userId,
      listed: explanationAuthorship.listed,
      showName: explanationAuthorship.showName,
    })
    .from(explanationAuthorship)
    .where(eq(explanationAuthorship.explanationId, explanationId))
    .limit(1);

  return row ?? null;
}

/** Which row, whose, and the new choice. */
export interface SetShowNameParams {
  /** Produced by `resolveOwnAuthorship` in the same request. Never read from form data. */
  explanationId: string;
  userId: number;
  showName: boolean;
}

/**
 * Sets whether the author's public name is written beside one explanation.
 *
 * @param db The database handle.
 * @param params The row, its claimed author, and the new choice.
 * @returns whether a row was actually updated, so a caller can answer a mismatch
 *   the way a stale id is answered: nothing happened, and no 500.
 */
export async function setShowName(db: DictionaryDb, params: SetShowNameParams): Promise<boolean> {
  const updated = await db
    .update(explanationAuthorship)
    .set({ showName: params.showName, updatedAt: new Date() })
    .where(
      and(
        eq(explanationAuthorship.explanationId, params.explanationId),
        eq(explanationAuthorship.userId, params.userId),
      ),
    )
    .returning({ explanationId: explanationAuthorship.explanationId });

  return updated.length > 0;
}

/** Which row, whose, and the new choice. */
export interface SetListedParams {
  /** Produced by `resolveOwnAuthorship` in the same request. Never read from form data. */
  explanationId: string;
  userId: number;
  listed: boolean;
}

/**
 * Sets whether one explanation appears on the public pages.
 *
 * @param db The database handle.
 * @param params The row, its claimed author, and the new choice.
 * @returns whether a row was actually updated. See `setShowName`.
 */
export async function setListed(db: DictionaryDb, params: SetListedParams): Promise<boolean> {
  const updated = await db
    .update(explanationAuthorship)
    .set({ listed: params.listed, updatedAt: new Date() })
    .where(
      and(
        eq(explanationAuthorship.explanationId, params.explanationId),
        eq(explanationAuthorship.userId, params.userId),
      ),
    )
    .returning({ explanationId: explanationAuthorship.explanationId });

  return updated.length > 0;
}

/** Whose claims to drop, and which question they were about. */
export interface DeleteOwnAuthorshipForKeyParams {
  userId: number;
  /** `explanations.from_language_code`, as the ask stored it. Raw, never defaulted. */
  fromLanguage: string;
  /** `explanations.to_language_code`, as the ask stored it. Raw, never defaulted. */
  toLanguage: string;
  questionNormalized: string;
}

/**
 * Drops every claim one reader holds over one question.
 *
 * IT IS KEYED ON THE QUESTION AND NOT ON ONE ROW, because a question can have
 * opened more than one ledger row: a first attempt that failed and the retry
 * that answered it are two rows under one key, and this reader authored both.
 * Naming a single row would leave the other one behind, listed, ready to turn
 * public the moment anything reads it.
 *
 * `userId` STAYS IN THE `WHERE` CLAUSE, so a row another reader authored under
 * the same key is not this caller's to drop. The subquery narrows the ledger to
 * the key; this clause narrows the claims to the person.
 *
 * @param db The database handle.
 * @param params The reader, and the ask's own stored key.
 * @returns how many rows went, so a caller can tell a withdrawal from a no-op.
 */
export async function deleteOwnAuthorshipForKey(
  db: DictionaryDb,
  params: DeleteOwnAuthorshipForKeyParams,
): Promise<number> {
  const deleted = await db
    .delete(explanationAuthorship)
    .where(
      and(
        eq(explanationAuthorship.userId, params.userId),
        inArray(
          explanationAuthorship.explanationId,
          db
            .select({ id: explanations.id })
            .from(explanations)
            .where(
              and(
                eq(explanations.fromLanguageCode, params.fromLanguage),
                eq(explanations.toLanguageCode, params.toLanguage),
                eq(explanations.questionNormalized, params.questionNormalized),
              ),
            ),
        ),
      ),
    )
    .returning({ explanationId: explanationAuthorship.explanationId });

  return deleted.length;
}

/** A name to write beside one explanation. */
export interface PublicByline {
  name: string;
}

/**
 * The name to show beside one explanation, or null when there is none to show.
 *
 * TWO CONDITIONS, AND BOTH ARE READ LIVE. The author must have turned the byline
 * on for this row, and their profile must still carry a public name. Clearing
 * the name in `/settings` is an update of one column, so it takes the byline off
 * every past explanation at once, with no per-row write.
 *
 * @param db The database handle.
 * @param explanationId The ledger row.
 */
export async function resolvePublicByline(db: DictionaryDb, explanationId: string): Promise<PublicByline | null> {
  const [row] = await db
    .select({ publicName: userProfiles.publicName })
    .from(explanationAuthorship)
    .innerJoin(userProfiles, eq(userProfiles.userId, explanationAuthorship.userId))
    .where(and(eq(explanationAuthorship.explanationId, explanationId), eq(explanationAuthorship.showName, true)))
    .limit(1);

  if (row === undefined || row.publicName === null) return null;
  return { name: row.publicName };
}
