/**
 * Where the explain pane reads and retries, and what tells it that the reader is
 * looking at a different question.
 *
 * IT IS THE SIBLING OF `translationPaneEndpoints`, AND IT IS SEPARATE FOR ONE
 * REASON. That function switches on `TranslationPaneTarget`, whose three members
 * are the translator's: a headword, a sentence, or nothing. An explain target is
 * a question and two languages, and folding a fourth member into that union
 * would mean every reader of it had to know about a screen it does not serve.
 * The REDUCER is shared, which is where the drift would actually have hurt; two
 * URL builders cannot disagree about anything but a URL.
 *
 * THE ROUTES TAKE THE QUESTION AS TYPED, NOT A FOLDED KEY. The server folds it
 * with `explainKeyFromRequest`, which is the same fold the loader used when it
 * queued the run. A client-side fold here would be a second implementation of
 * the cache key, and the day the two disagreed every poll would miss the row the
 * loader had just written while looking perfectly correct.
 *
 * NO IMPORTS BUT TYPES. This module is reached by the client bundle.
 */

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { TranslationPaneEndpoints, TranslationWaitPhase } from '#app/lib/translation/pane-state';

/**
 * What the explain pane is asking about.
 *
 * `none` IS A REAL MEMBER, NOT AN OMISSION. The landing screen renders the pane
 * with nothing to poll, and saying so here is what lets `explainPaneEndpoints`
 * return null exactly once instead of every caller testing an empty string.
 */
export type ExplainPaneTarget =
  /** One question, polled by the text itself, which the server folds into the cache key. */
  | { kind: 'question'; question: string; from: LanguageCode; to: LanguageCode }
  /** Nothing asked yet: the empty landing screen. */
  | { kind: 'none' };

/**
 * Where this question is read and retried, or null when nothing was asked.
 *
 * BOTH URLS COME FROM ONE FUNCTION, so a poll and its retry can never address
 * two different things.
 *
 * @param target What the pane is asking about.
 * @returns The poll and retry URLs, or null for a target with neither.
 */
export function explainPaneEndpoints(target: ExplainPaneTarget): TranslationPaneEndpoints | null {
  if (target.kind === 'none') return null;
  const query = `q=${encodeURIComponent(target.question)}&from=${target.from}&to=${target.to}`;
  return { poll: `/api/explain?${query}`, retry: `/api/explain/retry?${query}` };
}

/**
 * A string that changes exactly when the pane is looking at something else.
 *
 * IT IS THE POLL URL, because that URL already names every part of the target: a
 * different question, a different source language or a different answer language
 * is a different URL. Deriving it here rather than concatenating fields at the
 * call site means a member added to the union above cannot be forgotten by the
 * re-seed while still being polled.
 *
 * @param target What the pane is asking about.
 * @returns The seed key, or `none` for a target with nothing to poll.
 */
export function explainPaneSeedKey(target: ExplainPaneTarget): string {
  return explainPaneEndpoints(target)?.poll ?? 'none';
}

/**
 * The sentence each waiting phase shows.
 *
 * THE PHASES THEMSELVES ARE THE TRANSLATOR'S, NOT A SECOND SET.
 * `translationPaneWaitPhase` reads the same `elapsedMs` the ninety second stall
 * rule uses, advanced by the poll tick, so this screen and that one have ONE
 * idea of how long a run has been waiting. A timer of its own here would be a
 * second one, and the two would disagree by a tick forever.
 *
 * ONLY THE SENTENCES DIFFER, and they have to: the translator is waiting for a
 * word and this screen is waiting for a five-part document, so "Checking the
 * examples" is true here and means nothing there. A table over the union, so a
 * fourth phase fails the typecheck rather than falling into whichever branch was
 * last.
 */
const EXPLAIN_WAITING_KEYS = {
  first: 'explain.waitingThinking',
  second: 'explain.waitingWriting',
  third: 'explain.waitingExamples',
} satisfies Record<TranslationWaitPhase, string>;

/**
 * Which sentence a pane in this phase shows.
 *
 * A PURE FUNCTION over the phase, so the choice can be asserted without a DOM or
 * a clock: this repo has neither in its unit tier.
 *
 * @param phase How long the pane has been waiting, as the shared machine reports it.
 * @returns The locale key of the sentence to show.
 */
export function explainWaitingKey(phase: TranslationWaitPhase): string {
  return EXPLAIN_WAITING_KEYS[phase];
}
