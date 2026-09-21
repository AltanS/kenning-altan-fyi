/**
 * One quiz session: the queue, the flip, and a run streak. No storage write.
 *
 * THE QUEUE ENGINE IS REUSED, NOT REBUILT. `startReviewSession`,
 * `currentCard`, `recordVerdict`, `isReviewComplete` and `REVIEW_VERDICTS`
 * come straight from `app/lib/review/session.ts`, the same shuffle, the same
 * "still-learning goes to the back of THIS session" rule, the same "no
 * scheduling algorithm" scope fence its own header states. A second copy of
 * that logic here would be a second place `still-learning` could come to mean
 * something slightly different, for a screen that is otherwise presentational
 * only.
 *
 * SESSION-ONLY, ON PURPOSE, AND THAT IS A NARROWER PROMISE THAN `/review`
 * MAKES. `ReviewSessionView` (`app/components/review-session.tsx`) persists a
 * tally to `reviewState`, keyed by the card's id, because every id there is a
 * real `LocalListItem` id. A quiz card's id is NOT always one: it can name a
 * `search_history` row, an `explanation_asks` row, or a shared
 * `quiz_scaffold_cards` row, none of which `reviewState` has a slot for.
 * Persisting verdicts across sessions for a mixed deck like this is a real
 * product decision, what does "still learning" even mean for a word
 * borrowed from the shared scaffold pool, and it is out of scope here,
 * deliberately, the same way `session.ts`'s own header declines to build a
 * spaced-repetition algorithm. See M203's README non-goals.
 *
 * THE STREAK IS DERIVED, NOT STORED. It counts consecutive `gotIt` verdicts
 * within this render only, and resets on `stillLearning` or on "quiz again".
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { QuizFlipCard } from '#app/components/quiz/quiz-flip-card';
import {
  currentCard,
  isReviewComplete,
  recordVerdict,
  REVIEW_VERDICTS,
  startReviewSession,
  type ReviewCard,
  type ReviewSession,
  type ReviewVerdict,
} from '#app/lib/review/session';

export interface QuizSessionViewProps {
  cards: ReviewCard[];
}

export function QuizSessionView({ cards }: QuizSessionViewProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState<ReviewSession>(() => startReviewSession({ cards, seed: Date.now() }));
  const [isFlipped, setIsFlipped] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);

  const card = currentCard(session);

  const onVerdict = useCallback(
    (verdict: ReviewVerdict) => {
      if (card === null) return;

      setSession((previous) => recordVerdict({ session: previous, verdict }));
      setIsFlipped(false);
      setStreak((previous) => {
        const next = verdict === REVIEW_VERDICTS.gotIt ? previous + 1 : 0;
        setBestStreak((best) => Math.max(best, next));
        return next;
      });
      setAnnouncement(
        verdict === REVIEW_VERDICTS.gotIt ?
          t('review.gotItAnnouncement', { lemma: card.lemma })
        : t('review.stillLearningAnnouncement', { lemma: card.lemma }),
      );
    },
    [card, t],
  );

  const onAgain = useCallback(() => {
    setSession(startReviewSession({ cards, seed: Date.now() }));
    setIsFlipped(false);
    setAnnouncement('');
    setStreak(0);
    setBestStreak(0);
  }, [cards]);

  if (isReviewComplete(session) || card === null) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 text-center">
        <h2 className="font-display text-2xl font-semibold">{t('quiz.summaryTitle')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('quiz.summaryBody', { total: session.totalCards, stillLearning: session.stillLearningCount })}
        </p>
        {bestStreak > 1 && (
          <p className="text-sm font-medium text-brand-ink">{t('quiz.bestStreak', { count: bestStreak })}</p>
        )}
        <Button type="button" onClick={onAgain}>
          {t('quiz.again')}
        </Button>
        <Link to="/" className="text-sm text-brand-ink underline underline-offset-4">
          {t('nudge.backToSearch')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h2 className="text-center font-display text-lg font-semibold">{t('quiz.heading')}</h2>
      <QuizFlipCard
        card={card}
        isFlipped={isFlipped}
        onFlip={() => setIsFlipped((flipped) => !flipped)}
        onVerdict={onVerdict}
        announcement={announcement}
        progress={t('review.progress', { done: session.retired.length, total: session.totalCards })}
        streak={streak > 1 ? t('quiz.streak', { count: streak }) : null}
      />
    </div>
  );
}
