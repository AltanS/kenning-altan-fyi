import type { Route } from './+types/explanations';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ExternalLink, Trash2 } from 'lucide-react';
import { ItemActionsMenu } from '#app/components/item-actions-menu';
import { Link } from '#app/components/link';
import { languageName } from '#app/components/personal/saved-word-row';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { formatRelativeTime } from '#app/lib/relative-time';
import type { TitleHandle } from '#app/lib/route-title';
import { withdrawOwnAuthorship } from '#app/lib/authorship/withdraw-own-authorship.server';
import { resolveUser } from '#app/middleware/auth';
import {
  EXPLANATION_ASKS_MAX_ROWS,
  EXPLANATION_ASKS_PAGE_SIZE,
  listExplanationAsks,
  removeExplanationAsk,
} from '#app/models/explanation-asks.server';
import { explanationKeyString, explanationStandings } from '#app/models/explanations.server';
import { getRawDb } from '#drizzle/db';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'explanations.metaTitle') },
    { name: 'description', content: metaTitle(language, 'explanations.metaDescription') },
  ];
};

/** The name of this screen, for the chrome's `h1`. */
export const handle = { titleKey: 'nav.explanations' } satisfies TitleHandle;

/** How much of an answer one row shows before it is cut. */
const PREVIEW_CHARS = 140;

/** The sentence a row shows when there is no answer to preview. */
const STATE_KEYS = {
  pending: 'explanations.statePending',
  failed: 'explanations.stateFailed',
  budget: 'explanations.stateUnanswered',
  ok: 'explanations.stateUnanswered',
} as const;

/**
 * How many rows this request shows.
 *
 * "SHOW MORE" GROWS THE WINDOW RATHER THAN TURNING A PAGE, so `?page=2` is the
 * first forty rows and not the second twenty. The URL then says exactly what is
 * on screen: a reader who has pressed it three times can share or reload the
 * page and get what they were looking at, and the back button steps back through
 * the presses. A fetcher appending to client state would lose all three the
 * moment anything navigated.
 *
 * AN UNREADABLE OR OUT-OF-RANGE `page` IS ONE PAGE, never an error. It arrives
 * from a URL a person can type.
 */
function windowSize(pageParam: string | null): number {
  const parsed = z.coerce.number().int().min(1).safeParse(pageParam ?? '1');
  const page = parsed.success ? parsed.data : 1;
  return Math.min(page * EXPLANATION_ASKS_PAGE_SIZE, EXPLANATION_ASKS_MAX_ROWS);
}

/**
 * The questions this reader has asked.
 *
 * IT READS TWO TABLES AND JOINS THEM IN MEMORY, which is deliberate. The asks
 * carry the reader and the answers carry none, so there is no foreign key
 * between them and there must not be: `explanations` is a shared ledger that
 * names nobody, and the whole point of the second table is that it stays that
 * way. The join is on the cache key the two already agree about,
 * `(from, to, question_normalized)`.
 *
 * THE PREVIEWS COST TWO QUERIES FOR THE WHOLE PAGE, not two per row. See
 * `explanationStandings`.
 *
 * One `now` for the whole page, taken here rather than during render, so every
 * row is measured against the same instant.
 *
 * THE ROUTE IS UNDER `_app.gated`, so `accountMiddleware` has already refused a
 * signed-out request before this runs. `resolveUser` is read for the id, and the
 * null branch is a type narrowing rather than a second gate.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await resolveUser(request);
  if (user === null) return { entries: [], total: 0, shown: 0, nextPage: null, nowMs: Date.now() };

  const url = new URL(request.url);
  const limit = windowSize(url.searchParams.get('page'));
  const { rows, total } = await listExplanationAsks(user.id, { limit });

  const standings = await explanationStandings(
    getRawDb(),
    rows.map((row) => ({ from: row.fromLanguage, to: row.toLanguage, questionNormalized: row.questionNormalized })),
  );

  const entries = rows.map((row) => {
    const standing = standings.get(
      explanationKeyString({ from: row.fromLanguage, to: row.toLanguage, questionNormalized: row.questionNormalized }),
    );
    const answer = standing?.answer ?? null;
    return {
      id: row.id,
      question: row.question,
      from: row.fromLanguage,
      to: row.toLanguage,
      askedAt: row.askedAt.getTime(),
      /** The beginning of the answer, or null when there is none to show. */
      preview: answer === null ? null : answer.answer.slice(0, PREVIEW_CHARS),
      /** The sentence to show instead of a preview, or null when there is a preview. */
      stateKey: answer === null ? STATE_KEYS[standing?.status ?? 'ok'] : null,
    };
  });

  const nextPage = rows.length < total ? Math.floor(rows.length / EXPLANATION_ASKS_PAGE_SIZE) + 1 : null;
  return { entries, total, shown: rows.length, nextPage, nowMs: Date.now() };
}

const INTENT = { REMOVE: 'remove' } as const;

const explanationsFormSchema = z.object({
  intent: z.literal(INTENT.REMOVE),
  id: z.coerce.number().int().positive(),
});

/**
 * Removes one ask, and the reader's claim on the answer it resolved to.
 *
 * THE READER IS PART OF THE WHERE CLAUSE, inside both models, so a submitted id
 * that belongs to somebody else deletes nothing and answers the same way a
 * removal of a row that was already gone does. There is nothing here to tell the
 * two apart with.
 *
 * THE DETAIL PAGE DOES THE SAME TWO WRITES IN THE SAME ORDER. Its own action
 * carries the argument for that order; this row offers the same control, so it
 * cannot do less.
 */
export async function action({ request }: Route.ActionArgs) {
  const user = await resolveUser(request);
  if (user === null) return { success: false, error: 'unauthenticated' };

  const parsed = explanationsFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };

  // Withdraw first: a failure between the two leaves the ask in place with
  // nothing public attached, which is the safe half to be left holding.
  await withdrawOwnAuthorship(getRawDb(), { userId: user.id, askId: parsed.data.id });
  await removeExplanationAsk(user.id, parsed.data.id);
  return { success: true };
}

/** One asked question, as the row renders it. */
interface AskView {
  id: number;
  question: string;
  from: string;
  to: string;
  askedAt: number;
  preview: string | null;
  stateKey: string | null;
}

/**
 * One asked question.
 *
 * IT IS A HISTORY ROW, NOT A CARD. DESIGN.md section 3: a list of things a
 * reader did is chronological and repetitive, so it is set quieter than a list
 * of things they chose, with no card and no shadow and rows separated by a
 * hairline. A page of cards here would read as a page of answers, which is what
 * the detail screen is for.
 *
 * THE WHOLE ROW IS THE LINK AND THE ACTIONS SIT BESIDE IT, never inside it: a
 * button nested in an anchor is a control a keyboard cannot reach without also
 * following the link. They are behind one overflow menu rather than beside the
 * row as a word, so twenty rows carry twenty small triggers and not twenty
 * competing "Remove" buttons.
 */
function AskRow({ ask, nowMs }: { ask: AskView; nowMs: number }) {
  const { t, i18n } = useTranslation();

  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-center gap-1">
        <Link
          to={`/explanations/${ask.id}`}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-3 hover:bg-primary/5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{ask.question}</span>
            <span className="line-clamp-2 text-sm text-muted-foreground">
              {ask.preview ?? t(ask.stateKey ?? 'explanations.stateUnanswered')}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('explanations.pair', { from: languageName(ask.from), to: languageName(ask.to) })}{' '}
              <time dateTime={new Date(ask.askedAt).toISOString()} className="tabular-nums">
                {formatRelativeTime(ask.askedAt, nowMs, i18n.language)}
              </time>
            </span>
          </span>
        </Link>
        {/* THE TRIGGER NAMES THE QUESTION, which is what the visible "Remove"
            button beside it used to do through `removeLabel`. A glyph names
            nothing, and twenty rows each offering "More" is a list a screen
            reader cannot move around in. */}
        <ItemActionsMenu
          label={t('explanations.rowActionsLabel', { question: ask.question })}
          actions={[
            // The whole row is still the link. This row repeats it because a
            // menu that opens on a single destructive choice is a menu that
            // only ever destroys, and because a reader who opened it looking
            // for the way in should find one.
            { kind: 'link', key: 'open', label: t('explanations.open'), to: `/explanations/${ask.id}`, icon: ExternalLink },
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
              formData: { intent: INTENT.REMOVE, id: ask.id },
              // `onSuccess` runs on the action's own answer, so a removal that
              // failed says nothing rather than claiming a row is gone.
              onSuccess: () => toast.success(t('explanations.removedToast')),
            },
          ]}
        />
      </div>
    </li>
  );
}

export default function ExplanationsRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { entries, total, shown, nextPage, nowMs } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {entries.length === 0 && (
        <div className="surface-brand-soft rounded-xl border border-dashed p-6">
          <h2 className="font-display text-base font-semibold">{t('explanations.emptyTitle')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('explanations.emptyBody')}</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="flex flex-col gap-3">
          <ul>
            {entries.map((entry) => (
              <AskRow key={entry.id} ask={entry} nowMs={nowMs} />
            ))}
          </ul>

          {/* A LINK, NOT A BUTTON, because it goes somewhere: the wider window
              is a URL. It says how many of how many are on screen, so a reader
              knows what pressing it buys. */}
          {nextPage !== null && (
            <div className="px-3">
              <Link to={`?page=${nextPage}`} className="text-sm underline underline-offset-4">
                {t('explanations.showMore', { shown, total })}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
