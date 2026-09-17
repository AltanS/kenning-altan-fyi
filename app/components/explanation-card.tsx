import { useTranslation } from 'react-i18next';
import { CopyTextButton } from '#app/components/copy-text-button';
import { ExplanationBody } from '#app/components/explanation-body';
import { Button } from '#app/components/ui/button';
import { Skeleton } from '#app/components/ui/skeleton';
import type { ExplainPaneController } from '#app/components/explain-pane';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { explanationToText } from '#app/lib/translation/explanation-text';
import type { TranslationRefusal } from '#app/lib/translation/explain-panel.server';

/** The house recipe for a quiet line inside an answer card. The same one the translation pane uses. */
const QUIET_LINE = 'text-sm text-muted-foreground';

/**
 * The sentence each refusal renders, as a table over the union.
 *
 * A TABLE RATHER THAN A CHAIN OF COMPARISONS, so a fifth refusal added to
 * `TranslationRefusal` fails the typecheck here instead of silently falling into
 * whatever the last branch said. `satisfies` is what makes that true: it checks
 * the keys against the union without widening the value type.
 *
 * THE KEYS ARE `explain.*`, NOT THE TRANSLATOR'S, AND THAT IS NOT DUPLICATION.
 * Two of the four sentences would be WRONG if they were shared: `too-long` names
 * the cap, which is 300 here and 200 there, and the budget line names what has
 * run out. A reader told "today's translation limit is reached" on a screen that
 * translates nothing has been told something untrue.
 */
const EXPLAIN_REFUSAL_KEYS = {
  'rate-limited': 'explain.rateLimited',
  budget: 'explain.budget',
  'daily-cap': 'explain.budget',
  'too-long': 'explain.tooLong',
} satisfies Record<TranslationRefusal, string>;

/**
 * The locale key one `budget` view renders.
 *
 * A PURE FUNCTION over the union, so the choice can be asserted without a DOM:
 * this repo has none.
 *
 * @param reason Which guard produced the refusal, or `null` on a view this
 *   function is never called for.
 */
export function explainBudgetKey(reason: TranslationRefusal | null): string {
  return reason === null ? 'explain.budget' : EXPLAIN_REFUSAL_KEYS[reason];
}

export interface ExplanationCardProps {
  controller: ExplainPaneController;
  /**
   * The question this card answers, as the reader typed it.
   *
   * IT IS A PROP RATHER THAN SOMETHING THE CARD DERIVES, because the card is
   * handed an answer and nothing else. The copy button writes the question above
   * the answer: a pasted answer with no question is half a note.
   */
  question: string;
  /** The language the terms are in. It sets `lang` on every word so a screen reader says them properly. */
  from: LanguageCode;
  /** The language the prose is in, and the target the "also look up" links carry. */
  to: LanguageCode;
}

/**
 * Three bars in place of the answer, while the model writes it.
 *
 * A SKELETON RATHER THAN ONE SPINNER LINE, because this wait is long: an explain
 * call is the slowest thing this app makes, and a single line of text beside a
 * spinner gives a reader nothing to look at for twenty seconds and no sense of
 * what is coming. The bars say an answer of some size is on its way. The phased
 * sentence above them says how it is going; the pair is DESIGN.md section 7's
 * rule for a long operation.
 */
function AnswerSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/**
 * The explanation, as a read-only card directly under the box the question was
 * typed in.
 *
 * IT MATCHES THE INPUT CARD EXACTLY, `rounded-2xl border p-5` with no brand
 * wash, which is the translator surface's rule in DESIGN.md section 3 and holds
 * here for the same reason: a control and its answer that look alike read as one
 * thing.
 *
 * ONE SWITCH OVER ONE VALUE, the same five states the translation pane renders,
 * from the same `translationPaneView`. `stalled` is not `failed`: the run may
 * still be finishing, so the line asks the reader to come back rather than
 * announcing a failure this screen cannot see.
 *
 * THE ANSWER ITSELF IS `ExplanationBody`, which the saved-ask page renders too.
 * This file owns the card, the waiting states and the header; it does not own
 * the document.
 */
export function ExplanationCard({ controller, question, from, to }: ExplanationCardProps) {
  const { t } = useTranslation();
  const { view, answer, waitingKey } = controller;
  const isAnswered = view === 'ready' && answer !== null;

  return (
    <div className="rounded-2xl border p-5">
      {/* THE HEADER ROW, AND THE COPY CONTROL IS THE ONLY THING THAT MAY JOIN
          THE LABEL THERE. It acts on the whole card rather than on any one
          section of it. `min-h` keeps the label on the same line whether or not
          the button is drawn, so an answer arriving does not shift the card
          under the reader's eye. It matches the button's own touch height below
          `sm`, or the row would grow by twelve pixels the moment the answer
          lands, which is the shift this `min-h` exists to prevent. */}
      <div className="flex min-h-11 items-center justify-between gap-3 sm:min-h-8">
        <p className="text-sm font-medium">{t('explain.answerLabel')}</p>
        {isAnswered && (
          <CopyTextButton
            text={explanationToText(answer, { question, from, to })}
            label={t('explanations.copy')}
            copiedLabel={t('explanations.copied')}
            successMessage={t('explanations.copiedToast')}
            errorMessage={t('explanations.copyFailedToast')}
          />
        )}
      </div>
      <div className="mt-3">
        {isAnswered && answer !== null && <ExplanationBody answer={answer} from={from} to={to} variant="card" />}

        {view === 'translating' && (
          <div className="flex flex-col gap-3">
            {/* THE SENTENCE CHANGES AS THE WAIT GOES ON. See `waitingKey` on the
                controller: three phases, so a reader who has been looking at
                this for half a minute is told something new rather than the same
                line they read at the start. */}
            <p aria-live="polite" className={QUIET_LINE}>
              {t(waitingKey)}
            </p>
            <AnswerSkeleton />
          </div>
        )}

        {view === 'stalled' && <p className={QUIET_LINE}>{t('explain.stillWorking')}</p>}

        {view === 'failed' && (
          <div className="flex flex-wrap items-center gap-3">
            <p className={QUIET_LINE}>{t('explain.failed')}</p>
            <Button type="button" variant="outline" size="sm" onClick={controller.retry} pending={controller.isRetrying}>
              {controller.isRetrying ? t('explain.retrying') : t('explain.retry')}
            </Button>
          </div>
        )}

        {view === 'budget' && <p className={QUIET_LINE}>{t(explainBudgetKey(controller.refusalReason))}</p>}

        {/* `no-entry` here is "nothing has been asked", which only the landing
            screen reaches, and that screen renders no card at all. A `ready`
            panel with a null answer cannot be produced by the server either, so
            this line is a guard rather than a state: it must not claim a failure
            the run did not report. */}
        {view === 'no-entry' && <p className={QUIET_LINE}>{t('explain.landingHint')}</p>}
        {view === 'ready' && answer === null && <p className={QUIET_LINE}>{t('explain.landingHint')}</p>}
      </div>
    </div>
  );
}
