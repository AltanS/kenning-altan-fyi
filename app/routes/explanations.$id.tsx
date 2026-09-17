import type { Route } from './+types/explanations.$id';
import { ArrowLeft, Copy, Link2, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { data, useNavigate, type MetaFunction } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ItemActionsMenu } from '#app/components/item-actions-menu';
import { useExplainPane } from '#app/components/explain-pane';
import { ExplanationBody } from '#app/components/explanation-body';
import { Link } from '#app/components/link';
import { languageName } from '#app/components/personal/saved-word-row';
import { Button } from '#app/components/ui/button';
import { Skeleton } from '#app/components/ui/skeleton';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import type { TitleHandle } from '#app/lib/route-title';
import { isPairLanguage } from '#app/lib/dictionary/language-pair';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { explainBudgetKey } from '#app/components/explanation-card';
import type { ExplainPaneTarget } from '#app/lib/translation/explain-pane';
import { resolveExplainPanel, type ExplainPanel } from '#app/lib/translation/explain-panel.server';
import { explanationToText } from '#app/lib/translation/explanation-text';
import { resolveUser } from '#app/middleware/auth';
import { getExplanationAsk, removeExplanationAsk } from '#app/models/explanation-asks.server';
import { getRawDb } from '#drizzle/db';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'explanations.detailMetaTitle') },
    { name: 'description', content: metaTitle(language, 'explanations.metaDescription') },
  ];
};

/**
 * The name of this screen, for the chrome's `h1`.
 *
 * IT NAMES THE SCREEN, NOT THE QUESTION. The question is the page's own heading
 * a few lines down, at reading size and unabridged; the chrome header truncates
 * to one line, so putting it there would show the first four words of it twice.
 */
export const handle = { titleKey: 'nav.explanations' } satisfies TitleHandle;

/** The route's own id, as a number, or null when the path segment is not one. */
function askId(value: string | undefined): number | null {
  const parsed = z.coerce.number().int().positive().safeParse(value ?? '');
  return parsed.success ? parsed.data : null;
}

/**
 * A stored language code, narrowed for the components that need a real one.
 *
 * THE COLUMNS ARE PLAIN TEXT, on purpose: a row written when a language was
 * served must stay readable after it is withdrawn. The fallback keeps that row
 * rendering rather than throwing a page away over a `lang` attribute.
 */
function asLanguage(code: string, fallback: LanguageCode): LanguageCode {
  return isPairLanguage(code) ? code : fallback;
}

/**
 * One question this reader asked, and wherever its answer has got to.
 *
 * THE ROW IS THE SOURCE OF EVERY VALUE ON THE SCREEN, and the URL supplies only
 * the id. The question, the two languages and the instant all come from the
 * stored row, so a hand-edited query string cannot make this page claim a
 * question was asked in a pair it was not, and the "ask again" link cannot lead
 * somewhere the row does not say. DESIGN.md principle 6: a control that names
 * the data names the data that was USED.
 *
 * THE PANEL IS READ, NEVER TRIGGERED. `resolveExplainPanel` holds no request, so
 * it cannot ask the rate limiter anything and it starts nothing. Opening an old
 * question must not spend money, and a page of these opened in tabs must not
 * spend it twenty times. The reader can still press retry on a failed one, which
 * goes through the gated POST like every other trigger.
 *
 * A ROW THAT IS NOT THIS READER'S IS A 404, indistinguishable from one that
 * never existed: the model puts the user in the WHERE clause, so there is
 * nothing here to tell the two apart with.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await resolveUser(request);
  if (user === null) throw data(null, { status: 404 });

  const id = askId(params.id);
  if (id === null) throw data(null, { status: 404 });

  const ask = await getExplanationAsk(user.id, id);
  if (ask === null) throw data(null, { status: 404 });

  const panel: ExplainPanel = await resolveExplainPanel(getRawDb(), {
    question: ask.question,
    questionNormalized: ask.questionNormalized,
    from: asLanguage(ask.fromLanguage, 'de'),
    to: asLanguage(ask.toLanguage, 'en'),
  });

  return {
    id: ask.id,
    question: ask.question,
    from: ask.fromLanguage,
    to: ask.toLanguage,
    askedAt: ask.askedAt.getTime(),
    panel,
  };
}

const INTENT = { REMOVE: 'remove' } as const;

const detailFormSchema = z.object({ intent: z.literal(INTENT.REMOVE) });

/**
 * Removes this ask, and nothing else.
 *
 * THE ANSWER IN `explanations` STAYS. It names nobody, so there is nothing of
 * this reader in it to remove, and it is the installation's record of a run it
 * paid for. What goes is the link between the person and the question.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await resolveUser(request);
  if (user === null) return { success: false, error: 'unauthenticated' };

  const id = askId(params.id);
  if (id === null) return { success: false, error: 'invalid-form' };

  const parsed = detailFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };

  await removeExplanationAsk(user.id, id);
  return { success: true };
}

/** The house recipe for a quiet line on this page. */
const QUIET_LINE = 'text-sm text-muted-foreground';

/** Three bars in place of the answer, while the model writes it. The card under the question box shows the same. */
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
 * One asked question, on a page of its own.
 *
 * IT RENDERS EVERY STATE THE CARD DOES, THROUGH THE SAME CONTROLLER. A reader
 * opening a question they asked a moment ago meets a run that is still going,
 * and `useExplainPane` is what polls it to completion and offers the retry when
 * it failed. Rendering only the answered case would have made half the rows on
 * the list screen lead to a blank page.
 *
 * THE ACTIONS ARE BEHIND ONE OVERFLOW CONTROL, on the metadata line under the
 * question. They are still the four things a reader wants from an answer they
 * came back to, ask it again, take the text, take the address, or be rid of it,
 * and they used to be four buttons in a band across the page. Below `sm` that
 * band stacked, so a phone showed four 44px controls between the question and
 * the answer and the answer began off screen.
 */
export default function ExplanationDetailRoute({ loaderData }: Route.ComponentProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { id, question, from, to, askedAt, panel } = loaderData;

  const language = { from: asLanguage(from, 'de'), to: asLanguage(to, 'en') };
  const target: ExplainPaneTarget = { kind: 'question', question, from: language.from, to: language.to };
  const explanation = useExplainPane({ panel, target });
  const { view, answer, waitingKey } = explanation;

  const askAgainHref = `/explain?${new URLSearchParams({ q: question, from, to }).toString()}`;
  const answerText = answer === null ? '' : explanationToText(answer, { question, from, to });
  // THE ADDRESS AS THE BROWSER HAS IT, read off `globalThis` rather than
  // through a `typeof` test, which the lint gate refuses. During the server
  // render there is no `location`, and the path alone is the fallback: nothing
  // can be copied from a page nobody has yet received, so the fallback is never
  // what lands on a clipboard.
  const pageUrl = globalThis.location?.href ?? `/explanations/${id}`;
  const askedOn = new Date(askedAt).toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          to="/explanations"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-4"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('explanations.back')}
        </Link>

        {/* THE QUESTION IS THE TITLE. It carries `lang` of the language it was
            written in, which is the language the answer is in: a question is
            written in the reader's own language about words in another. */}
        <h1 lang={to} className="font-display text-xl sm:text-2xl font-semibold tracking-tight leading-snug">
          {question}
        </h1>

        {/* THE ACTIONS SIT BESIDE THE METADATA, NOT ACROSS THE PAGE. They were
            a band of four buttons under the question, full width and stacked
            below `sm`, which on a phone put four 44px controls between the
            question and its answer and pushed the answer off screen. One
            trigger on this line gives that space back to the writing. */}
        <div className="flex items-start justify-between gap-2">
          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>{t('explanations.pair', { from: languageName(from), to: languageName(to) })}</span>
            <span aria-hidden="true">&middot;</span>
            <time dateTime={new Date(askedAt).toISOString()} className="tabular-nums">
              {askedOn}
            </time>
          </p>

          <ItemActionsMenu
            label={t('explanations.actionsLabel')}
            actions={[
              { kind: 'link', key: 'ask-again', label: t('explanations.askAgain'), to: askAgainHref, icon: RotateCcw },
              // NO ANSWER, NO ROW. A question whose run is still going or has
              // failed has nothing to put on a clipboard, and a copy control
              // over an empty string is a control that lies about what it holds.
              answer === null ?
                null
              : {
                  kind: 'copy',
                  key: 'copy-answer',
                  label: t('explanations.copy'),
                  text: answerText,
                  successMessage: t('explanations.copiedToast'),
                  errorMessage: t('explanations.copyFailedToast'),
                  icon: Copy,
                },
              {
                kind: 'copy',
                key: 'copy-link',
                label: t('explanations.copyLink'),
                text: pageUrl,
                successMessage: t('explanations.linkCopiedToast'),
                errorMessage: t('explanations.copyFailedToast'),
                icon: Link2,
              },
              {
                kind: 'confirm',
                key: 'remove',
                label: t('explanations.removeTrigger'),
                destructive: true,
                icon: Trash2,
                title: t('explanations.removeTitle'),
                description: t('explanations.removeBody'),
                confirmText: t('explanations.removeConfirm'),
                confirmPendingText: t('explanations.removePending'),
                cancelText: t('explanations.removeCancel'),
                formData: { intent: INTENT.REMOVE },
                // THE LIST IS WHERE A REMOVED ROW LEAVES THE READER. Staying
                // here would leave them on a page whose row no longer exists,
                // which a reload turns into a 404.
                onSuccess: () => {
                  toast.success(t('explanations.removedToast'));
                  void navigate('/explanations');
                },
              },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {view === 'ready' && answer !== null && (
          <ExplanationBody answer={answer} from={language.from} to={language.to} variant="page" />
        )}

        {view === 'translating' && (
          <div className="flex flex-col gap-3">
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
            <Button type="button" variant="outline" size="sm" onClick={explanation.retry} pending={explanation.isRetrying}>
              {explanation.isRetrying ? t('explain.retrying') : t('explain.retry')}
            </Button>
          </div>
        )}

        {view === 'budget' && <p className={QUIET_LINE}>{t(explainBudgetKey(explanation.refusalReason))}</p>}

        {/* `no-entry` is "nothing was ever asked", which this page cannot reach:
            it is loaded from a row that says otherwise. It is drawn as the same
            sentence a never-answered question gets rather than as a failure the
            run did not report. */}
        {view === 'no-entry' && <p className={QUIET_LINE}>{t('explanations.stateUnanswered')}</p>}
        {view === 'ready' && answer === null && <p className={QUIET_LINE}>{t('explanations.stateUnanswered')}</p>}
      </div>
    </div>
  );
}
