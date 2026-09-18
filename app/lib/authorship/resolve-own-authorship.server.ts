/**
 * The one ownership check every authorship mutation shares (M200).
 *
 * IT TAKES AN ASK ID AND NEVER AN EXPLANATION ID, and that is the whole design.
 * The two are different rows in different tables: `explanation_asks.id` is the
 * reader's own log entry, scoped to them by the model's own `WHERE` clause, and
 * `explanations.id` is a row in the shared, readerless ledger that anybody's
 * question may have resolved to. A helper that accepted an explanation id would
 * be a helper a route could call with a value the client sent, which is exactly
 * the defect this function exists to make unrepresentable.
 *
 * THREE CHECKS, IN THIS ORDER, AND NONE OF THEM IS SKIPPABLE BY A CALLER.
 *   (1) The ask is THIS reader's. `getExplanationAsk` puts the user in the
 *       `WHERE` clause beside the id, so another account's row and a row that
 *       never existed both read as `null`, with nothing to tell them apart.
 *   (2) The ask resolves to an answered ledger row, NOW. The cache key is folded
 *       from the ask's own stored question and languages, never from a value on
 *       the request, and `resolveExplainPanel` is the read-only half, so this
 *       call can neither enqueue nor spend. The value is re-derived on every
 *       call rather than carried on the ask row, because the ask predates
 *       knowing which attempt would answer it.
 *   (3) The authorship row for THAT explanation names this reader. A reader
 *       whose own ask resolved to a row somebody else's attempt produced, the
 *       retry-misattribution case, fails here and gets the same `null`.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 */
import { storedLanguage } from '#app/lib/dictionary/language-pair';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { resolveExplainPanel } from '#app/lib/translation/explain-panel.server';
import { getExplanationAsk } from '#app/models/explanation-asks.server';
import { getAuthorshipOwner } from '#app/models/explanation-authorship.server';

/** Who is asking, and about which of their own asks. */
export interface ResolveOwnAuthorshipParams {
  userId: number;
  /** `explanation_asks.id`. The reader's own log entry, never a ledger row id. */
  askId: number;
}

/** What the caller may act on, once all three checks passed. */
export interface OwnAuthorship {
  /** The ledger row this ask resolves to right now. The ONLY id a mutation may use. */
  explanationId: string;
  listed: boolean;
  showName: boolean;
}

/**
 * The explanation this reader's own ask resolves to, when they authored it.
 *
 * @param db The database handle.
 * @param params The reader, and one of their own ask ids.
 * @returns the row and its two flags, or `null` when any of the three checks
 *   above says no. A single `null` covers a stale id, another account's ask, an
 *   unanswered question and a row somebody else authored, deliberately: every
 *   one of them means the same thing to a caller, which is that there is nothing
 *   here for this reader to grant or withdraw.
 */
export async function resolveOwnAuthorship(
  db: DictionaryDb,
  { userId, askId }: ResolveOwnAuthorshipParams,
): Promise<OwnAuthorship | null> {
  const ask = await getExplanationAsk(userId, askId);
  if (ask === null) return null;

  const panel = await resolveExplainPanel(db, {
    question: ask.question,
    questionNormalized: ask.questionNormalized,
    from: storedLanguage({ code: ask.fromLanguage, fallback: 'de' }),
    to: storedLanguage({ code: ask.toLanguage, fallback: 'en' }),
    // No tally is wanted here: this call asks who owns a row, not how it scored.
    accountId: null,
  });
  if (panel.state !== 'ready') return null;

  const owner = await getAuthorshipOwner(db, panel.explanationId);
  if (owner === null || owner.userId !== userId) return null;

  return { explanationId: panel.explanationId, listed: owner.listed, showName: owner.showName };
}
