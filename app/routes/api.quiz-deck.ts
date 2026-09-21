import type { Route } from './+types/api.quiz-deck';
import { isServedLanguage, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { needsScaffold, QUIZ_DECK_TARGET_COUNT } from '#app/lib/quiz/build-deck';
import { requestScaffoldIfNeeded } from '#app/lib/quiz/scaffold-enqueue.server';
import type { ReviewCard } from '#app/lib/review/session';
import { resolveUser } from '#app/middleware/auth';
import { listExplanationAsks } from '#app/models/explanation-asks.server';
import { explanationKeyString, explanationStandings } from '#app/models/explanations.server';
import { listScaffoldCards } from '#app/models/quiz.server';
import { listSearchHistory } from '#app/models/search-history.server';
import { getRawDb } from '#drizzle/db';

/**
 * `GET /api/quiz-deck?from=<code>&to=<code>&favorites=<n>`, the server half of
 * one quiz deck: this reader's matching search history, their answered
 * `/explain` questions, and the shared scaffold pool for the pair.
 *
 * FAVOURITES NEVER APPEAR HERE. They live in this device's own store
 * (`app/routes/favourites.tsx`'s header comment says why) and the server
 * cannot read them. `app/routes/quiz.tsx` merges them in on the client, the
 * same way `/favourites` and `/lists` already read local rows the server has
 * no query for.
 *
 * `favorites` IS A COUNT, NOT A LIST, and it exists for exactly one decision:
 * whether this pair's organic material is thin enough to top up from the
 * scaffold pool (`needsScaffold`). Without it, a reader with fifteen kept
 * words and no search history would still trigger a needless backfill on
 * every visit, because the server would see zero organic candidates of its
 * own. The count crossing the wire teaches the server nothing about which
 * words those are.
 *
 * IT CAN ENQUEUE, UNLIKE THE TRANSLATION AND EXPLAIN POLL ROUTES. Those are
 * polled every few seconds while a reader watches a spinner, so a poll that
 * enqueues would charge for every tick. This route is called once when a quiz
 * screen opens, and `requestScaffoldIfNeeded` is itself a no-op for every
 * pair but the very first thin one, guarded by `claimScaffoldRun`'s unique
 * row. See `app/lib/quiz/scaffold-enqueue.server.ts`.
 */

/** How many of this reader's history rows to read before filtering to the pair. Generous, since most will not match. */
const HISTORY_READ_LIMIT = 200;

/** How many of this reader's asks to read before filtering to the pair. */
const EXPLANATION_READ_LIMIT = 50;

/** How much of an answer becomes the back of a quiz card. Shorter than the `/explanations` list preview: a flashcard back is read at a glance, not skimmed. */
const EXPLANATION_CARD_CHARS = 100;

function toLanguage(value: string | null): LanguageCode | null {
  return isServedLanguage(value) ? value : null;
}

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const user = await resolveUser(request);
  if (user === null) return Response.json({ history: [], explanations: [], scaffold: [] });

  const url = new URL(request.url);
  const from = toLanguage(url.searchParams.get('from'));
  const to = toLanguage(url.searchParams.get('to'));
  // SAME PAIR IS REFUSED HERE TOO, not just unusual. `quiz.tsx`'s clientLoader
  // never sends one, its pair always comes from the device's own persisted
  // selection, but a caller hitting this endpoint directly could, and a
  // `from === to` request would still reach `needsScaffold` below and could
  // trigger a real, billed model call to scaffold a language into itself.
  if (from === null || to === null || from === to) return Response.json({ history: [], explanations: [], scaffold: [] });

  const favoritesCount = Math.max(0, Number.parseInt(url.searchParams.get('favorites') ?? '0', 10) || 0);
  const db = getRawDb();

  const historyRows = await listSearchHistory(user.id, HISTORY_READ_LIMIT);
  const history: ReviewCard[] = historyRows
    .filter((row) => row.fromLanguage === from && row.toLanguage === to && row.translation !== null)
    .map((row) => ({ id: `history:${row.id}`, lemma: row.query, translation: row.translation ?? '', note: '' }));

  const { rows: askRows } = await listExplanationAsks(user.id, { limit: EXPLANATION_READ_LIMIT });
  const matchingAsks = askRows.filter((row) => row.fromLanguage === from && row.toLanguage === to);
  const standings = await explanationStandings(
    db,
    matchingAsks.map((row) => ({ from: row.fromLanguage, to: row.toLanguage, questionNormalized: row.questionNormalized })),
  );
  const explanationCards: ReviewCard[] = matchingAsks
    .map((row) => {
      const answer = standings.get(
        explanationKeyString({ from: row.fromLanguage, to: row.toLanguage, questionNormalized: row.questionNormalized }),
      )?.answer;
      if (answer === undefined || answer === null) return null;
      return { id: `explain:${row.id}`, lemma: row.question, translation: answer.answer.slice(0, EXPLANATION_CARD_CHARS), note: '' };
    })
    .filter((card): card is ReviewCard => card !== null);

  const organicCount = favoritesCount + history.length + explanationCards.length;
  if (needsScaffold(organicCount)) {
    await requestScaffoldIfNeeded(db, { from, to });
  }

  const scaffoldRows = await listScaffoldCards(db, { from, to, limit: QUIZ_DECK_TARGET_COUNT });
  const scaffold: ReviewCard[] = scaffoldRows.map((row) => ({
    id: `scaffold:${row.id}`,
    lemma: row.lemma,
    translation: row.translation,
    note: row.note ?? '',
  }));

  return Response.json({ history, explanations: explanationCards, scaffold });
}
