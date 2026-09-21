import type { Route } from './+types/quiz';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { QuizSessionView } from '#app/components/quiz/quiz-session';
import { Skeleton } from '#app/components/ui/skeleton';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { DETECT, DEFAULT_PAIR } from '#app/lib/dictionary/language-pair';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { TitleHandle } from '#app/lib/route-title';
import { getLanguagePair, listFavorites } from '#app/lib/local-store';
import { assembleQuizDeck } from '#app/lib/quiz/build-deck';
import type { ReviewCard } from '#app/lib/review/session';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'quiz.metaTitle') },
    { name: 'description', content: metaTitle(language, 'quiz.metaDescription') },
  ];
};

export const handle = { titleKey: 'nav.quiz' } satisfies TitleHandle;

/** The server's half of the deck, exactly as `/api/quiz-deck` answers it. */
interface QuizDeckResponse {
  history: ReviewCard[];
  explanations: ReviewCard[];
  scaffold: ReviewCard[];
}

const EMPTY_SERVER_DECK: QuizDeckResponse = { history: [], explanations: [], scaffold: [] };

/**
 * One quiz deck: this device's favourites, merged with the server's read of
 * this reader's matching search history, their answered `/explain`
 * questions, and the shared scaffold pool, topped up on the server when the
 * organic total is thin.
 *
 * A CLIENT LOADER, LIKE `/favourites`, `/lists` AND `/review`, AND FOR THE
 * SAME FIRST REASON: favourites live in IndexedDB on this device, and a
 * server loader would have nothing to read them with. It is not offline-safe
 * the way those three are, though: the deck also needs a network round trip
 * to `/api/quiz-deck` for the organic history/explanation material and the
 * scaffold pool, so a reader with the network off gets a deck built from
 * favourites alone rather than a full one.
 *
 * THE PAIR COMES FROM THE DEVICE'S OWN PERSISTED SELECTION
 * (`app/lib/dictionary/language-pair.ts`), the same value the translator
 * screen's language bar writes. `detect` on the source side resolves to
 * English here: a quiz needs one concrete pair to query, and there is no
 * request to detect a language FROM the way a typed search has one.
 */
export async function clientLoader(): Promise<{
  cards: ReviewCard[];
  from: LanguageCode;
  to: LanguageCode;
}> {
  const pair = await getLanguagePair();
  const from: LanguageCode = pair !== null && pair.source !== DETECT ? pair.source : 'en';
  const to: LanguageCode = pair?.target ?? DEFAULT_PAIR.target;

  const favorites = await listFavorites();
  const matchingFavorites: ReviewCard[] = favorites
    .filter((favorite) => favorite.from === from && favorite.to === to)
    .map((favorite) => ({ id: favorite.id, lemma: favorite.lemma, translation: favorite.translationSnapshot, note: '' }));

  const server = await fetchServerDeck({ from, to, favoritesCount: matchingFavorites.length });

  const cards = assembleQuizDeck({
    favorites: matchingFavorites,
    history: server.history,
    explanations: server.explanations,
    scaffold: server.scaffold,
  });

  return { cards, from, to };
}

/** The server half of the deck. A failed or offline fetch answers an empty one rather than throwing: favourites alone still make a quiz. */
async function fetchServerDeck(params: { from: LanguageCode; to: LanguageCode; favoritesCount: number }): Promise<QuizDeckResponse> {
  try {
    const query = new URLSearchParams({ from: params.from, to: params.to, favorites: String(params.favoritesCount) });
    const response = await fetch(`/api/quiz-deck?${query.toString()}`, { headers: { accept: 'application/json' } });
    if (!response.ok) return EMPTY_SERVER_DECK;
    // SAFETY: the body is whatever `routes/api.quiz-deck.ts` serialised, which
    // returns the full `{ history, explanations, scaffold }` shape on every
    // exit path, including its two early `Response.json({ history: [],
    // explanations: [], scaffold: [] })` returns for a signed-out,
    // unrecognised-language, or same-language request. Same-origin, same
    // deploy, one route.
    return (await response.json()) as QuizDeckResponse;
  } catch {
    return EMPTY_SERVER_DECK;
  }
}

/** The device answers in a frame or two, so the wait is a shape, not a spinner. */
export function HydrateFallback() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <Skeleton className="h-4 w-24 self-center" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export default function QuizRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { cards } = loaderData;

  if (cards.length === 0) {
    return (
      <div className="surface-brand-soft mx-auto flex w-full max-w-md flex-col gap-2 rounded-xl border border-dashed p-6 text-center">
        <h2 className="font-display text-base font-semibold">{t('quiz.emptyTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('quiz.emptyBody')}</p>
      </div>
    );
  }

  return <QuizSessionView cards={cards} />;
}
