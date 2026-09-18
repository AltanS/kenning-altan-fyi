/**
 * What a reader takes back when they remove a question (M200).
 *
 * WHAT IT DOES. Given one of the caller's own ask ids, it deletes every
 * `explanation_authorship` row this reader holds over that question. It is the
 * first half of a remove: `removeExplanationAsk` drops the reader's private log
 * entry, and this drops their public claim, which used to survive it.
 *
 * IT TAKES AN ASK ID AND NEVER AN EXPLANATION ID, the rule
 * `resolve-own-authorship.server.ts` states at length for the same reason. The
 * ask is proved to be the caller's by `getExplanationAsk`, which puts the reader
 * in the `WHERE` clause, so a stale id and another account's id both read as no
 * row and withdraw nothing.
 *
 * IT IS KEYED ON THE QUESTION, NOT ON A `ready` PANEL. Resolving the panel first
 * would withdraw nothing from a question whose run is still `pending` or has
 * `failed`, and that is exactly the row that must not be left behind: it turns
 * public the moment the run settles, under a name the reader chose before they
 * changed their mind. Keying on the ask's own stored `(from, to,
 * question_normalized)` also covers the reader who authored more than one row
 * for one question, a failed attempt and the retry that answered it.
 *
 * THE KEY IS COMPARED RAW. The ask's stored language codes go to the query as
 * they are, never through `storedLanguage`, whose fallback would turn an
 * unreadable code into `de`/`en` and match rows about a different question
 * entirely.
 *
 * IT IS A DELETE, NOT `listed = false`. After it, nothing in the database ties
 * the account to the question, which is what "remove" says on the dialog. A
 * flag left behind would be a record of who asked, kept by the one action a
 * reader takes to be rid of it.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 */
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { getExplanationAsk } from '#app/models/explanation-asks.server';
import { deleteOwnAuthorshipForKey } from '#app/models/explanation-authorship.server';

/** Who is withdrawing, and from which of their own asks. */
export interface WithdrawOwnAuthorshipParams {
  userId: number;
  /** `explanation_asks.id`. The reader's own log entry, never a ledger row id. */
  askId: number;
}

/**
 * Takes back every claim this reader holds over one of their own asks.
 *
 * @param db The database handle.
 * @param params The reader, and one of their own ask ids.
 * @returns how many authorship rows went. Zero is an ordinary answer: the ask
 *   was not theirs, or never existed, or they never authored the answer they
 *   were served.
 */
export async function withdrawOwnAuthorship(
  db: DictionaryDb,
  { userId, askId }: WithdrawOwnAuthorshipParams,
): Promise<number> {
  const ask = await getExplanationAsk(userId, askId);
  if (ask === null) return 0;

  return deleteOwnAuthorshipForKey(db, {
    userId,
    fromLanguage: ask.fromLanguage,
    toLanguage: ask.toLanguage,
    questionNormalized: ask.questionNormalized,
  });
}
