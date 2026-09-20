/**
 * The reasons a reader may give for rejecting one generated answer, and the
 * cooldown that stands between a rejection and a second paid re-run.
 *
 * NO IMPORTS, AND NONE MAY BE ADDED, except `import type`. The reason buttons
 * are rendered in the browser, so this module is reached by the client bundle.
 * A value import of anything under `drizzle/` would drag the whole Drizzle
 * schema, and with it `pg`, into that bundle; in this repo that breaks ONLY the
 * production client build, while `pnpm dev` and `pnpm typecheck` both stay
 * green, so nothing earlier catches it. The same rule, for the same reason, as
 * `app/lib/translation/limits.ts`.
 *
 * THE CONSTANT AND THE PREDICATE SIT TOGETHER on purpose: a cooldown window
 * whose value lives in one file and whose arithmetic lives in another is a
 * window that can be changed in one place only. `app/lib/votes/score.ts` keeps
 * `REENRICH_COOLDOWN_HOURS` beside `isCooldownActive` for the same reason, and
 * this is that pair for the translation side.
 */

/**
 * The fixed set of rejection reasons.
 *
 * A CODE, NEVER FREE TEXT. Free text about a word, written by a named reader,
 * is exactly the search log this product says it does not keep: a sentence like
 * "wrong, I meant the tool not the gesture" is the query and the person on one
 * row. Four codes carry enough signal to triage an answer and cannot carry a
 * confession.
 *
 * `drizzle/schema/translation-feedback.ts` builds the check constraint on
 * `translation_rejection_signals.reason` FROM THIS TUPLE, so the database and
 * the TypeScript union can never drift apart. ADDING A MEMBER THEREFORE NEEDS A
 * MIGRATION: the constraint has to be dropped and rewritten, and a row written
 * with a code the old constraint does not know is refused by Postgres.
 */
export const REJECTION_REASONS = ['missing', 'wrong', 'register', 'other'] as const;

/** One of {@link REJECTION_REASONS}. */
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * How long one (headword, direction) pair must wait between queued re-runs.
 *
 * THIS IS A SPEND GUARD, NOT BOOKKEEPING, the same job
 * `REENRICH_COOLDOWN_HOURS` does for enrichment. A re-translation is a paid
 * model call, and without a window a small group of readers can order one for
 * the same word as often as they can press the button, which makes the bill
 * theirs to set rather than ours.
 *
 * TWENTY FOUR HOURS, and the number is an argument rather than a round figure.
 * A reader who rejects an answer has said their piece; the rejection is
 * recorded and it counts. A SECOND paid re-run of the same headword in the same
 * direction inside a day buys nothing new, because neither input has changed:
 * the corpus the prompt is built from is the same corpus, and the model behind
 * it is the same model. It would be the same call, at the same price, for the
 * same answer.
 */
export const RETRANSLATION_COOLDOWN_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Whether this (headword, direction) pair is still inside its cooldown window.
 *
 * Pure, and it takes the clock as an argument so the unit tier can hold it to
 * arithmetic with no database and no fake timers in front of it. It mirrors
 * `isCooldownActive` in `app/lib/votes/score.ts` down to the boundary: the
 * comparison is strict, so a stamp exactly `RETRANSLATION_COOLDOWN_HOURS` old
 * is OUT of the window rather than on its last second.
 *
 * @param lastQueuedAt When a re-translation was last queued for the pair, or
 *   `null` when one never was.
 * @param now The current time.
 * @returns `false` for a `null` timestamp: never queued means there is nothing
 *   to wait for, not that the caller must wait forever.
 */
export function isRetranslationCooldownActive(lastQueuedAt: Date | null, now: Date): boolean {
  if (lastQueuedAt === null) return false;
  const elapsedMs = now.getTime() - lastQueuedAt.getTime();
  return elapsedMs < RETRANSLATION_COOLDOWN_HOURS * MS_PER_HOUR;
}
