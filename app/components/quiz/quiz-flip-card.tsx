import { useTranslation } from 'react-i18next';
import { REVIEW_VERDICTS, type ReviewCard, type ReviewVerdict } from '#app/lib/review/session';
import { Button } from '#app/components/ui/button';

/**
 * One quiz card, drawn as a real 3D flip rather than the plain swap
 * `app/components/flashcard.tsx` uses.
 *
 * A SEPARATE COMPONENT FROM `Flashcard`, DELIBERATELY, per the milestone this
 * belongs to (M203/03): the quiz is meant to read as its own, more playful
 * surface, not as `/review` with a new heading. What differs is presentation
 * only, the underlying queue, shuffle and still-learning logic is the SAME
 * engine `app/lib/review/session.ts` already provides and already tests; see
 * `quiz-session.tsx` for why that reuse is not optional.
 *
 * NO NEW COLOUR AND NO LEFT BORDER ACCENT. DESIGN.md section 10 bans the
 * second outright, and "fun" here comes from motion and layout, not from a
 * palette Kenning's mono amber design does not have room for. The flip is a
 * genuine 3D rotation (`[transform-style:preserve-3d]` and a
 * `[backface-visibility:hidden]` face on each side) rather than a fade, and it
 * is what makes this card read as a different kind of control than the plain
 * review one even though it shares every token.
 *
 * THE CARD IS A REAL `<button>`, for the same accessibility reason
 * `Flashcard` gives: already reachable by Tab, already fires on Enter and
 * Space, already announces itself as a toggle via `aria-pressed`.
 */
export interface QuizFlipCardProps {
  card: ReviewCard;
  isFlipped: boolean;
  onFlip: () => void;
  onVerdict: (verdict: ReviewVerdict) => void;
  /** What the live region should say right now. Empty means nothing has happened yet. */
  announcement: string;
  /** The progress line above the card, already formatted by the session view. */
  progress: string;
  /** How many cards in a row this reader has answered "got it", already formatted. */
  streak: string | null;
}

export function QuizFlipCard({ card, isFlipped, onFlip, onVerdict, announcement, progress, streak }: QuizFlipCardProps) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex w-full items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>{progress}</span>
        {streak !== null && (
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 font-medium text-brand-ink">{streak}</span>
        )}
      </div>

      {/* THE PERSPECTIVE WRAPPER. `perspective` has to live on an ancestor of
          the rotating element, never on the element itself, or the 3D effect
          collapses into a flat cross-fade. */}
      <div className="w-full [perspective:1200px]">
        <button
          type="button"
          onClick={onFlip}
          aria-pressed={isFlipped}
          aria-label={t('quiz.cardLabel', { lemma: card.lemma })}
          className="relative min-h-64 w-full [transform-style:preserve-3d] transition-transform duration-500 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          style={{ transform: isFlipped ? 'rotateY(180deg)' : undefined }}
        >
          {/* THE FRONT: the word alone. `[backface-visibility:hidden]` is what
              keeps this face from showing through, mirrored, once the card has
              turned past ninety degrees. */}
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm [backface-visibility:hidden]">
            <span className="font-display text-3xl font-semibold break-words">{card.lemma}</span>
            <span className="text-xs text-muted-foreground">{t('review.flipToAnswer')}</span>
          </span>

          {/* THE BACK, PRE-ROTATED 180 DEGREES. It sits at the same spot as the
              front and only becomes right-side-up once the outer button has
              itself turned the other 180 degrees. */}
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-2xl border bg-primary/5 p-6 text-card-foreground shadow-sm [backface-visibility:hidden] [transform:rotateY(180deg)]">
            <span className="text-lg font-semibold break-words">{card.translation === '' ? t('review.noTranslation') : card.translation}</span>
            {card.note !== '' && (
              <span className="text-xs text-muted-foreground">
                <span className="font-medium">{t('review.noteLabel')}</span> {card.note}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{t('review.flipBack')}</span>
          </span>
        </button>
      </div>

      <div className="flex w-full gap-3">
        <Button type="button" variant="outline" className="flex-1" onClick={() => onVerdict(REVIEW_VERDICTS.stillLearning)}>
          {t('review.stillLearning')}
        </Button>
        <Button type="button" className="flex-1" onClick={() => onVerdict(REVIEW_VERDICTS.gotIt)}>
          {t('review.gotIt')}
        </Button>
      </div>

      <p aria-live="polite" className="min-h-4 text-center text-xs text-muted-foreground">
        {announcement}
      </p>
    </div>
  );
}
