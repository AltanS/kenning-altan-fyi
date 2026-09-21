/**
 * Assembling one quiz deck out of four sources, as a pure function.
 *
 * PURE AND STORE-FREE, the same rule `app/lib/review/daily-selection.ts` and
 * `app/lib/review/session.ts` follow: the caller gathers rows from IndexedDB
 * (favourites) and from two server reads (history, explanations) plus the
 * shared scaffold pool, and everything past that point is testable with no
 * browser and no database.
 *
 * ONE SHAPE FOR EVERY SOURCE, AND IT IS `ReviewCard`. A favourite, a searched
 * word, an asked question and a scaffold card are four different kinds of
 * row, but a quiz card only ever needs a front, a back and an optional note,
 * which is exactly what `#app/lib/review/session.ts` already takes. Reusing
 * that shape means this feature reuses the review engine's queue, shuffle and
 * still-learning logic UNCHANGED rather than writing a second one: see
 * `app/components/quiz/quiz-session.tsx`.
 *
 * PRIORITY, NOT A SCORE. Favourites are the reader's own explicit "I want to
 * remember this", so they lead. Searches are a weaker signal, so they follow.
 * A question the reader asked on `/explain` is weaker again: it proves
 * curiosity about a topic, not that the reader wants to memorise a word, so
 * it is included but last among the organic sources. The scaffold fills
 * whatever is left, and only when the organic material is thin, see
 * `needsScaffold`.
 */
import type { ReviewCard } from '#app/lib/review/session';

/** How many cards one quiz session offers, at most. */
export const QUIZ_DECK_TARGET_COUNT = 10;

/**
 * Below how many organic candidates a deck asks the scaffold pool (and, if it
 * is thin too, an LLM backfill) to fill the rest.
 *
 * SIX, NOT ZERO. A reader with two saved words and nothing else gets a deck
 * that is mostly borrowed vocabulary, which is still a quiz worth taking; the
 * alternative, refusing until the reader has ten words of their own, would
 * leave a brand new reader with no quiz to try at all.
 */
export const QUIZ_MIN_ORGANIC_BEFORE_SCAFFOLD = 6;

/** Whether a deck this thin on organic material should be topped up from the scaffold pool. */
export function needsScaffold(organicCount: number): boolean {
  return organicCount < QUIZ_MIN_ORGANIC_BEFORE_SCAFFOLD;
}

/** The four sources one deck is built from, already normalised to `ReviewCard`. */
export interface QuizDeckSources {
  /** The reader's own kept words. Leads every deck. */
  favorites: readonly ReviewCard[];
  /** Past searches that resolved to an answer. */
  history: readonly ReviewCard[];
  /** Questions asked on `/explain`, as lemma = question, translation = a short excerpt of the answer. */
  explanations: readonly ReviewCard[];
  /** The shared, LLM-written starter pool for this language pair. */
  scaffold: readonly ReviewCard[];
}

/**
 * One deck: the four sources, merged in priority order, deduplicated on the
 * front of the card, capped at {@link QUIZ_DECK_TARGET_COUNT}.
 *
 * DEDUPLICATED CASE-INSENSITIVELY ON `lemma`. The same word favourited AND
 * searched must produce one card, not two: a reader would otherwise meet
 * "Feierabend" twice in the same short session and read it as a bug.
 *
 * A BLANK LEMMA IS DROPPED, NEVER SHOWN. It cannot happen from any of the
 * four sources as they are meant to be built, but a card with nothing on its
 * front is not a card a reader can answer, so it is filtered rather than
 * trusted in.
 */
export function assembleQuizDeck(sources: QuizDeckSources): ReviewCard[] {
  const ordered = [...sources.favorites, ...sources.history, ...sources.explanations, ...sources.scaffold];
  const seen = new Set<string>();
  const deck: ReviewCard[] = [];

  for (const card of ordered) {
    const key = card.lemma.trim().toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    deck.push(card);
    if (deck.length >= QUIZ_DECK_TARGET_COUNT) break;
  }

  return deck;
}
