import type { Route } from './+types/explanations.$id';
import { useEffect, useId, useRef } from 'react';
import { ArrowLeft, Copy, Link2, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { data, useFetcher, useNavigate, type MetaFunction } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ItemActionsMenu } from '#app/components/item-actions-menu';
import { useExplainPane } from '#app/components/explain-pane';
import { ExplanationBody } from '#app/components/explanation-body';
import { ExplanationVotes } from '#app/components/explanation-votes';
import { Link } from '#app/components/link';
import { languageName } from '#app/components/personal/saved-word-row';
import { Button } from '#app/components/ui/button';
import { Label } from '#app/components/ui/label';
import { Skeleton } from '#app/components/ui/skeleton';
import { Switch } from '#app/components/ui/switch';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import type { TitleHandle } from '#app/lib/route-title';
import { storedLanguage } from '#app/lib/dictionary/language-pair';
import { resolveOwnAuthorship, type OwnAuthorship } from '#app/lib/authorship/resolve-own-authorship.server';
import { withdrawOwnAuthorship } from '#app/lib/authorship/withdraw-own-authorship.server';
import { explainBudgetKey } from '#app/components/explanation-card';
import type { ExplainPaneTarget } from '#app/lib/translation/explain-pane';
import { resolveExplainPanel, type ExplainPanel } from '#app/lib/translation/explain-panel.server';
import { explanationToText } from '#app/lib/translation/explanation-text';
import { resolveUser } from '#app/middleware/auth';
import { getExplanationAsk, removeExplanationAsk } from '#app/models/explanation-asks.server';
import { setListed, setShowName } from '#app/models/explanation-authorship.server';
import { getUserProfile } from '#app/models/user-profiles.server';
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
 *
 * THE AUTHORSHIP READ IS THE SAME CHECK THE ACTION MAKES, NOT A CHEAPER ONE.
 * `resolveOwnAuthorship` is asked only once an answer exists, because there is
 * nothing to grant or withdraw on a question that has none, and it answers
 * `null` for a reader whose own ask resolved to a row somebody else's attempt
 * produced. That reader gets no switch at all rather than a disabled one: a
 * disabled control would promise a permission this page cannot give them.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await resolveUser(request);
  if (user === null) throw data(null, { status: 404 });

  const id = askId(params.id);
  if (id === null) throw data(null, { status: 404 });

  const ask = await getExplanationAsk(user.id, id);
  if (ask === null) throw data(null, { status: 404 });

  const db = getRawDb();
  const panel: ExplainPanel = await resolveExplainPanel(db, {
    question: ask.question,
    questionNormalized: ask.questionNormalized,
    from: storedLanguage({ code: ask.fromLanguage, fallback: 'de' }),
    to: storedLanguage({ code: ask.toLanguage, fallback: 'en' }),
    // Past the 404 guard the reader is known, so the panel can report their own
    // vote and the buttons come back pressed after a reload.
    accountId: user.id,
  });

  const authorship = panel.state === 'ready' ? await resolveOwnAuthorship(db, { userId: user.id, askId: id }) : null;
  // Read only for an author, and only to decide whether the byline switch has a
  // name to show. A reader with no switch has no use for it.
  const profile = authorship === null ? null : await getUserProfile(db, user.id);

  return {
    id: ask.id,
    question: ask.question,
    from: ask.fromLanguage,
    to: ask.toLanguage,
    askedAt: ask.askedAt.getTime(),
    panel,
    authorship,
    hasPublicName: profile !== null && profile.publicName !== null,
  };
}

const INTENT = { REMOVE: 'remove', SHOW_NAME: 'show-name', LISTED: 'listed' } as const;

/** A switch's value as a form sends it. */
const flagField = z.enum(['true', 'false']).transform((value) => value === 'true');

// NO `explanationId` ANYWHERE IN THIS UNION, AND THAT IS THE POINT. The two
// toggles carry their intent and one boolean; the row they act on is derived
// again, server-side, from the ask id in the path.
const detailFormSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal(INTENT.REMOVE) }),
  z.object({ intent: z.literal(INTENT.SHOW_NAME), showName: flagField }),
  z.object({ intent: z.literal(INTENT.LISTED), listed: flagField }),
]);

/** Every way this action can answer. */
export type ExplanationDetailActionResult =
  | { success: true }
  | { success: false; error: 'unauthenticated' | 'invalid-form' | 'not-author' };

/**
 * Removes this ask, or changes what the reader shows beside the answer it
 * resolved to.
 *
 * A REMOVE WITHDRAWS THE AUTHORSHIP FIRST, THEN DROPS THE ASK. The ledger row
 * itself stays and still names nobody: it is the installation's record of a run
 * it paid for. The reader's claim on it does not stay. An authorship row left
 * behind would keep a question they just removed on the public pages, under
 * their name if they had turned the byline on, with its switches on a page that
 * now answers 404. The order is the safe one: a failure between the two writes
 * leaves the ask in place with nothing public attached, and pressing remove
 * again finishes the job.
 *
 * THE TWO TOGGLES RE-DERIVE THE ROW THEY WRITE TO, INDEPENDENTLY OF THE LOADER.
 * `resolveOwnAuthorship` is called again here with the ask id out of the path,
 * so nothing this action writes depends on a value the client sent, and a reader
 * who pastes somebody else's explanation id into the form body changes nothing:
 * the id is not read. A `null` answer is treated exactly as a stale id is,
 * nothing happens and nothing 500s.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<ExplanationDetailActionResult> {
  const user = await resolveUser(request);
  if (user === null) return { success: false, error: 'unauthenticated' };

  const id = askId(params.id);
  if (id === null) return { success: false, error: 'invalid-form' };

  const parsed = detailFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };
  const form = parsed.data;

  if (form.intent === INTENT.REMOVE) {
    // Withdraw first. See this action's own comment for why the order is the
    // safe one to be interrupted in.
    await withdrawOwnAuthorship(getRawDb(), { userId: user.id, askId: id });
    await removeExplanationAsk(user.id, id);
    return { success: true };
  }

  const db = getRawDb();
  const authorship = await resolveOwnAuthorship(db, { userId: user.id, askId: id });
  if (authorship === null) return { success: false, error: 'not-author' };

  const written =
    form.intent === INTENT.SHOW_NAME ?
      await setShowName(db, { explanationId: authorship.explanationId, userId: user.id, showName: form.showName })
    : await setListed(db, { explanationId: authorship.explanationId, userId: user.id, listed: form.listed });

  return written ? { success: true } : { success: false, error: 'not-author' };
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
  const { id, question, from, to, askedAt, panel, authorship, hasPublicName } = loaderData;

  const language = {
    from: storedLanguage({ code: from, fallback: 'de' }),
    to: storedLanguage({ code: to, fallback: 'en' }),
  };
  const target: ExplainPaneTarget = { kind: 'question', question, from: language.from, to: language.to };
  const explanation = useExplainPane({ panel, target });
  const { view, answer, waitingKey } = explanation;
  const isAnswered = view === 'ready' && answer !== null && explanation.explanationId !== null;

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

        {/* WHO AN ANSWER IS CREDITED TO, SAID ONCE AND TO EVERY READER. It is
            background information rather than a control, so it does not sit
            inside the author's own block below: the reader who most needs it is
            the one who asked this question, was served an answer somebody else's
            attempt produced, and therefore has no switch on this page at all. */}
        {answer !== null && <p className={QUIET_LINE}>{t('explanations.retryCredit')}</p>}

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

        {/* BESIDE THE METADATA, AND ONLY ONCE THERE IS AN ANSWER. A reader
            cannot judge the accuracy of prose that is still being written. The
            tally arrives on the panel the loader already resolved, so this adds
            no second fetch to the page. */}
        {isAnswered && explanation.explanationId !== null && (
          <ExplanationVotes
            explanationId={explanation.explanationId}
            up={explanation.up}
            down={explanation.down}
            myVote={explanation.myVote}
          />
        )}
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

      {/* BELOW THE ANSWER, NOT ABOVE IT. The reader came here to read; what they
          publish under it is the next question, not the first one. `authorship`
          is null for everyone but this row's own author, so nobody else meets a
          control they cannot use. */}
      {authorship !== null && <AuthorshipControls authorship={authorship} hasPublicName={hasPublicName} />}
    </div>
  );
}

/** The value a switch shows: the one in flight if there is one, else the stored one. */
function optimisticFlag(submitted: FormDataEntryValue | null | undefined, stored: boolean): boolean {
  if (submitted === null || submitted === undefined) return stored;
  return submitted === 'true';
}

/** What the author's own block needs: their two flags, and whether they have a name to show. */
interface AuthorshipControlsProps {
  authorship: OwnAuthorship;
  hasPublicName: boolean;
}

/**
 * What this reader publishes under the answer their question opened.
 *
 * TWO FETCHERS, ONE PER SWITCH, so flipping one does not grey out the other
 * while it is in flight. Each switch's shown value comes from its own
 * `fetcher.formData` first, the rule `/settings` states for the same control:
 * the in-flight submission already holds what the reader chose, and a second
 * copy in `useState` would disagree with it for one render on every toggle.
 *
 * NEITHER SWITCH SENDS A ROW ID. Both send their intent and one boolean; the
 * action derives the row from the ask id in the path. See its own comment.
 *
 * THE BYLINE SWITCH IS ONLY LOCKED WHEN IT IS ALREADY OFF. A reader who cleared
 * their public name in `/settings` still has a byline turned on here, and
 * locking the control outright left them a checked switch they could not
 * operate, with the opt-in waiting to resurface the moment they chose a new
 * name. Off is always reachable; on needs a name to show.
 *
 * A SAVE THAT DID NOT LAND SAYS SO. Both switches snap back to the stored value
 * when a submission fails, which on its own reads as a control that ignores the
 * reader. The `useRef` guard is what makes the message once-per-answer rather
 * than once-per-render: `t` has to be in the deps, and it changes identity on a
 * language switch.
 *
 * THE CC0 NOTICE IS KEYED ON `listed` ALONE, never on the byline. An item is
 * public by that flag whether or not a name is attached, so the disclosure says
 * what is actually true rather than what feels most relevant to disclose.
 */
function AuthorshipControls({ authorship, hasPublicName }: AuthorshipControlsProps) {
  const { t } = useTranslation();
  const nameFetcher = useFetcher<ExplanationDetailActionResult>();
  const listedFetcher = useFetcher<ExplanationDetailActionResult>();
  const reportedName = useRef<object | null>(null);
  const reportedListed = useRef<object | null>(null);

  const fieldId = useId();
  const listedId = `${fieldId}-listed`;
  const showNameId = `${fieldId}-show-name`;

  const showName = optimisticFlag(nameFetcher.formData?.get('showName'), authorship.showName);
  const listed = optimisticFlag(listedFetcher.formData?.get('listed'), authorship.listed);

  useEffect(() => {
    const answer = nameFetcher.data;
    if (answer === undefined || answer.success !== false || reportedName.current === answer) return;
    reportedName.current = answer;
    toast.error(t('explanations.authorshipNotSaved'));
  }, [nameFetcher.data, t]);

  useEffect(() => {
    const answer = listedFetcher.data;
    if (answer === undefined || answer.success !== false || reportedListed.current === answer) return;
    reportedListed.current = answer;
    toast.error(t('explanations.authorshipNotSaved'));
  }, [listedFetcher.data, t]);

  function toggleShowName(next: boolean): void {
    const body = new FormData();
    body.set('intent', INTENT.SHOW_NAME);
    body.set('showName', next ? 'true' : 'false');
    void nameFetcher.submit(body, { method: 'post' });
  }

  function toggleListed(next: boolean): void {
    const body = new FormData();
    body.set('intent', INTENT.LISTED);
    body.set('listed', next ? 'true' : 'false');
    void listedFetcher.submit(body, { method: 'post' });
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
      <div className="flex items-center gap-3">
        <Switch
          id={listedId}
          checked={listed}
          onCheckedChange={toggleListed}
          disabled={listedFetcher.state !== 'idle'}
        />
        <Label htmlFor={listedId}>{t('explanations.listedLabel')}</Label>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Switch
            id={showNameId}
            checked={showName}
            onCheckedChange={toggleShowName}
            disabled={(!hasPublicName && !showName) || nameFetcher.state !== 'idle'}
          />
          <Label htmlFor={showNameId}>{t('explanations.showNameLabel')}</Label>
        </div>
        {!hasPublicName && (
          <p className={QUIET_LINE}>
            {t('explanations.showNameNeedsName')}{' '}
            <Link to="/settings" className="underline underline-offset-4">
              {t('explanations.showNameSettingsLink')}
            </Link>
          </p>
        )}
      </div>

      <p className={QUIET_LINE}>{listed ? t('explanations.cc0NoticeListed') : t('explanations.cc0NoticeHidden')}</p>
    </div>
  );
}
