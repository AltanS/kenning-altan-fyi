import type { Route } from './+types/browse.explanations.$id';
import { useEffect, useId, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { data, useFetcher, type MetaFunction } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';

import { ExplanationBody } from '#app/components/explanation-body';
import { ExplanationVotes } from '#app/components/explanation-votes';
import { Link } from '#app/components/link';
import { languageName } from '#app/components/personal/saved-word-row';
import PublicWrapper from '#app/components/public-wrapper';
import { Button } from '#app/components/ui/button';
import { Label } from '#app/components/ui/label';
import { Textarea } from '#app/components/ui/textarea';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import { storedLanguage } from '#app/lib/dictionary/language-pair';
import { resolveUser } from '#app/middleware/auth';
import { resolvePublicByline } from '#app/models/explanation-authorship.server';
import { getPublicExplanation } from '#app/models/explanation-browse.server';
import { recordExplanationReport, REPORT_REASON_MAX_CHARS } from '#app/models/explanation-reports.server';
import { readVoteForAccount } from '#app/models/explanation-votes.server';
import { getRawDb } from '#drizzle/db';

/**
 * One answered question, on a public page of its own (M200).
 *
 * `:id` IS `explanations.id` DIRECTLY, a different id space from the private
 * `/explanations/:id`, which addresses the reader's own ask log. The two files
 * differ by the `browse.` prefix on purpose.
 *
 * EVERY REFUSAL IS THE SAME 404. A nonexistent id, a malformed one, a row that
 * never answered, a question an operator hid, a row its author un-listed, a row
 * with no authorship claim, and a row that is no longer the latest answered one
 * for its question all end here in exactly the same way. Distinguishing them
 * would let a stranger learn that a question exists and has been taken down,
 * which is the fact the take-down was about.
 *
 * THE ROUTE IS NOT BEHIND `authMiddleware`, so a signed-out reader is an
 * ordinary caller rather than a refused one. That is why the report action
 * answers a plain object instead of throwing a redirect: a thrown redirect is
 * the wrong refusal on a page a stranger is legitimately looking at.
 *
 * THE LOADER IS READ ONLY AND SPENDS NOTHING. It resolves no panel and starts no
 * run: the answer is already written, or this page does not exist.
 */
export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'browse.detailMetaTitle') },
    { name: 'description', content: metaTitle(language, 'browse.metaDescription') },
  ];
};

/** Where the licence these answers are released under is written out. */
const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

/** The house recipe for a quiet line on this page. */
const QUIET_LINE = 'text-sm text-muted-foreground';

/**
 * The path segment as a row id, or null when it is not one.
 *
 * IT IS VALIDATED BEFORE IT REACHES THE DATABASE. The column is `uuid`, and
 * Postgres answers a malformed value with an error rather than an empty result,
 * so an unchecked segment would turn a typed URL into a 500.
 */
function explanationId(value: string | undefined): string | null {
  const parsed = z.uuid().safeParse(value ?? '');
  return parsed.success ? parsed.data : null;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const id = explanationId(params.id);
  if (id === null) throw data(null, { status: 404 });

  const db = getRawDb();
  const explanation = await getPublicExplanation(db, { id });
  if (explanation === null) throw data(null, { status: 404 });

  // Optional, and a null answer is the ordinary case: this page has no gate.
  // The vote is read only so a signed-in reader's own button comes back pressed.
  const user = await resolveUser(request);
  const [myVote, byline] = await Promise.all([
    user === null ? Promise.resolve(null) : readVoteForAccount(db, { explanationId: id, accountId: user.id }),
    resolvePublicByline(db, id),
  ]);

  return { explanation, myVote, bylineName: byline?.name ?? null, isSignedIn: user !== null };
}

/**
 * What a report may carry.
 *
 * THE REASON IS OPTIONAL AND CAPPED. A reader who presses report without typing
 * anything has still said the useful half, and an uncapped free-text field on a
 * public page is an invitation to paste a novel into the operator's queue. An
 * empty box is `null` rather than `''`, so the column says "they sent nothing"
 * rather than "they sent an empty sentence".
 */
const reportFormSchema = z
  .object({ reason: z.string().trim().max(REPORT_REASON_MAX_CHARS).default('') })
  .transform((value) => ({ reason: value.reason.length === 0 ? null : value.reason }));

/** Every way the report action can answer. */
export type BrowseReportResult =
  { success: true } | { success: false; error: 'unauthenticated' | 'invalid-form' | 'not-found' };

/**
 * Records one reader's report on this answer.
 *
 * THE ORDER IS THE POINT. Sign-in first, because an anonymous report channel is
 * a channel for mass-flagging an answer somebody dislikes at no cost. The form
 * next. The visibility read LAST BEFORE THE WRITE, so a report on a row that is
 * already hidden, un-listed or gone writes nothing at all: the queue must not
 * fill with complaints about pages nobody can open.
 *
 * ACCEPTING `explanations.id` FROM THE PATH IS CORRECT HERE, and it is not the
 * thing spec 01 forbids. That rule is about AUTHORSHIP writes, where the id
 * decides whose row is changed. A report is any signed-in reader's own act of
 * flagging content they are looking at, exactly like a vote, and the id names
 * the public page they are on.
 *
 * REPORTING HIDES NOTHING. A person reads the queue and decides.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<BrowseReportResult> {
  const user = await resolveUser(request);
  if (user === null) return { success: false, error: 'unauthenticated' };

  const id = explanationId(params.id);
  if (id === null) return { success: false, error: 'invalid-form' };

  const parsed = reportFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };

  const db = getRawDb();
  const explanation = await getPublicExplanation(db, { id });
  if (explanation === null) return { success: false, error: 'not-found' };

  await recordExplanationReport(db, { explanationId: id, accountId: user.id, reason: parsed.data.reason });
  return { success: true };
}

export default function BrowseExplanationDetailRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { explanation, myVote, bylineName, isSignedIn } = loaderData;

  const language = {
    from: storedLanguage({ code: explanation.from, fallback: 'de' }),
    to: storedLanguage({ code: explanation.to, fallback: 'en' }),
  };

  return (
    <PublicWrapper>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Link
            to="/browse/explanations"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-4"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t('browse.back')}
          </Link>

          {/* THE QUESTION IS THE TITLE, carrying the `lang` of the language it
              was written in, which is the language the answer is in. */}
          <h1
            lang={explanation.to}
            className="font-display text-xl sm:text-2xl font-semibold tracking-tight leading-snug"
          >
            {explanation.question}
          </h1>

          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>
              {t('explanations.pair', {
                from: languageName(explanation.from),
                to: languageName(explanation.to),
              })}
            </span>
            {/* ONLY WHEN A NAME RESOLVED. The author had to turn the byline on
                for this row and still hold a public name, and it reads "asked
                by", never "by": they asked the question, a model wrote the
                answer. */}
            {bylineName !== null && <span>{t('browse.askedBy', { name: bylineName })}</span>}
          </p>

          <ExplanationVotes
            explanationId={explanation.id}
            up={explanation.up}
            down={explanation.down}
            myVote={myVote}
          />
        </div>

        <ExplanationBody answer={explanation.answer} from={language.from} to={language.to} variant="page" />

        <p className={QUIET_LINE}>
          {t('browse.licence')}{' '}
          <a href={CC0_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            {t('browse.licenceLink')}
          </a>
        </p>

        <ReportControl explanationId={explanation.id} isSignedIn={isSignedIn} />
      </div>
    </PublicWrapper>
  );
}

/**
 * The report control, at the foot of the page.
 *
 * AN INLINE FORM RATHER THAN AN OVERFLOW MENU ROW. The menu's confirm kind posts
 * a fixed body and has no slot for a text field, so it cannot carry the optional
 * reason, and a report with no way to say what is wrong is a report the operator
 * cannot act on.
 *
 * FOLDED AWAY UNTIL IT IS WANTED. The reader came here to read; a textarea
 * sitting open under every answer invites a complaint rather than offering one.
 *
 * A SIGNED-OUT READER SEES THE REASON, NOT A DEAD BUTTON. A disabled control
 * promises a permission this page cannot give them, and the link takes them
 * back here afterwards.
 */
function ReportControl({ explanationId: id, isSignedIn }: { explanationId: string; isSignedIn: boolean }) {
  const { t } = useTranslation();
  const fetcher = useFetcher<BrowseReportResult>();
  const reported = useRef<object | null>(null);
  const fieldId = useId();
  const reasonId = `${fieldId}-reason`;

  // ONCE PER ANSWER, NOT ONCE PER RENDER. The ref holds the answer object the
  // toast was fired for; `t` has to be in the deps because it changes identity
  // on a language switch.
  useEffect(() => {
    const answer = fetcher.data;
    if (answer === undefined || reported.current === answer) return;
    reported.current = answer;
    if (answer.success) toast.success(t('browse.reportSentToast'));
    else toast.error(t('browse.reportFailedToast'));
  }, [fetcher.data, t]);

  if (!isSignedIn) {
    return (
      <p className={QUIET_LINE}>
        <Link
          to={`${SIGN_IN_PATH}?next=${encodeURIComponent(`/browse/explanations/${id}`)}`}
          className="underline underline-offset-4"
        >
          {t('browse.reportSignIn')}
        </Link>
      </p>
    );
  }

  return (
    <details className="rounded-xl border p-4">
      <summary className="cursor-pointer text-sm font-medium">{t('browse.reportTitle')}</summary>
      <fetcher.Form method="post" className="mt-3 flex flex-col gap-3">
        <p className={QUIET_LINE}>{t('browse.reportBody')}</p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={reasonId}>{t('browse.reportReasonLabel')}</Label>
          <Textarea id={reasonId} name="reason" maxLength={REPORT_REASON_MAX_CHARS} />
        </div>
        <div>
          <Button type="submit" variant="outline" size="sm" pending={fetcher.state !== 'idle'}>
            {t('browse.reportSubmit')}
          </Button>
        </div>
      </fetcher.Form>
    </details>
  );
}
