import type { Route } from './+types/browse.explanations';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { z } from 'zod';

import { Link } from '#app/components/link';
import { languageName } from '#app/components/personal/saved-word-row';
import PublicWrapper from '#app/components/public-wrapper';
import { buttonVariants } from '#app/components/ui/button';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { SIGN_IN_PATH, SIGN_UP_PATH } from '#app/lib/auth/paths';
import { SERVED_LANGUAGES, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { LANGUAGE_OPTIONS } from '#app/lib/dictionary/language-pair';
import { cn } from '#app/lib/utils';
import { resolveUser } from '#app/middleware/auth';
import {
  listPublicExplanations,
  PUBLIC_EXPLANATIONS_MAX_ROWS,
  PUBLIC_EXPLANATIONS_PAGE_SIZE,
} from '#app/models/explanation-browse.server';
import { getRawDb } from '#drizzle/db';

/**
 * The public list of answered questions (M200).
 *
 * IT IS IN `_public`, NOT IN THE APP SHELL, and that is the whole reason this
 * file wraps itself in `PublicWrapper`. The shell's sidebar offers lists,
 * favourites and history, every one of them a dead end for a stranger, and this
 * is a page a stranger is meant to read. The two doors are in the page's own
 * body instead, the same arrangement `/welcome` and `/account` use.
 *
 * THE LOADER IS READ ONLY AND SPENDS NOTHING. It never enqueues, so a crawler
 * walking every row costs nothing but a query.
 *
 * WHAT IT NEVER SHOWS. There is no way from here to "everything one person
 * asked": the model behind it has no reader-shaped parameter at all, and
 * `tests/unit/explanation-listing-no-user-filter.test.ts` fails the build if one
 * ever appears. A name is written beside a row only when its author turned that
 * on for that row AND still holds a public name.
 */
export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'browse.metaTitle') },
    { name: 'description', content: metaTitle(language, 'browse.metaDescription') },
  ];
};

/** Where the licence these answers are released under is written out. */
const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

/** The option value the two selects use for "any language". Not a language code, so it reads as absent. */
const ANY_LANGUAGE = '';

/** The house recipe for a quiet line on this page. */
const QUIET_LINE = 'text-sm text-muted-foreground';

/** The select recipe, borrowed from the operator screens so the two do not read as two design systems. */
const CONTROL_CLASS =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * One filter value, or null for "any".
 *
 * AN UNREADABLE VALUE IS "ANY", never an error: the filter arrives from a URL a
 * person can type, and a 400 over a mistyped language code would be a page that
 * refuses to render because of a query string.
 */
function readLanguage(value: string | null): LanguageCode | null {
  const parsed = z.enum(SERVED_LANGUAGES).safeParse(value ?? '');
  return parsed.success ? parsed.data : null;
}

/**
 * How many rows this request shows.
 *
 * "SHOW MORE" GROWS THE WINDOW RATHER THAN TURNING A PAGE, the same rule the
 * reader's own ask list follows: `?page=2` is the first forty rows and not the
 * second twenty, so the URL says exactly what is on screen and the back button
 * steps back through the presses.
 */
function windowSize(pageParam: string | null): number {
  const parsed = z.coerce
    .number()
    .int()
    .min(1)
    .safeParse(pageParam ?? '1');
  const page = parsed.success ? parsed.data : 1;
  return Math.min(page * PUBLIC_EXPLANATIONS_PAGE_SIZE, PUBLIC_EXPLANATIONS_MAX_ROWS);
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const from = readLanguage(url.searchParams.get('from'));
  const to = readLanguage(url.searchParams.get('to'));
  const limit = windowSize(url.searchParams.get('page'));

  const [page, user] = await Promise.all([
    listPublicExplanations(getRawDb(), { from, to, limit, offset: 0 }),
    // Read for the footer's two doors and nothing else. A null answer is the
    // ordinary case here rather than a refusal: this route has no gate.
    resolveUser(request),
  ]);

  // COUNTED BEFORE ANY UNDECODABLE ROW IS DROPPED. `total` counts what the
  // filter holds and the window returned `min(limit, total)` of them, so a row
  // the model could not decode must not shorten the list by ending it early.
  const shown = Math.min(limit, page.total);

  return {
    rows: page.rows,
    total: page.total,
    shown,
    nextPage: shown < page.total ? Math.floor(shown / PUBLIC_EXPLANATIONS_PAGE_SIZE) + 1 : null,
    from,
    to,
    isSignedIn: user !== null,
  };
}

/** The filter and the window as one address, so "show more" cannot drop the languages. */
function windowHref(params: { from: string | null; to: string | null; page: number }): string {
  const search = new URLSearchParams();
  if (params.from !== null) search.set('from', params.from);
  if (params.to !== null) search.set('to', params.to);
  search.set('page', String(params.page));
  return `?${search.toString()}`;
}

/** One public answer, as a row draws it. */
type PublicRow = Route.ComponentProps['loaderData']['rows'][number];

/**
 * One answered question.
 *
 * A QUIET HAIRLINE ROW, NOT A CARD (DESIGN.md section 3). This is a list of
 * things to choose between, read at a glance; a page of cards would read as a
 * page of answers, which is what the detail screen is for.
 *
 * THE TALLY IS TEXT HERE, NOT A CONTROL. Voting happens on the answer itself,
 * where the reader can see what they are judging.
 */
function BrowseRow({ row }: { row: PublicRow }) {
  const { t } = useTranslation();

  return (
    <li className="border-b last:border-b-0">
      <Link
        to={`/browse/explanations/${row.id}`}
        className="flex min-w-0 flex-col gap-0.5 rounded-lg px-3 py-3 hover:bg-primary/5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="truncate text-sm font-medium" lang={row.to}>
          {row.question}
        </span>
        <span className="line-clamp-2 text-sm text-muted-foreground" lang={row.to}>
          {row.preview}
        </span>
        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>{t('explanations.pair', { from: languageName(row.from), to: languageName(row.to) })}</span>
          <span>{t('browse.tally', { up: row.up, down: row.down })}</span>
          {row.bylineName !== null && <span>{t('browse.askedBy', { name: row.bylineName })}</span>}
        </span>
      </Link>
    </li>
  );
}

/**
 * The language filter.
 *
 * A PLAIN GET FORM. The filter is a place, so it belongs in the URL: a reader
 * who filters can share or bookmark what they are looking at, and the back
 * button undoes it. The selects are native because there are four options and
 * nothing to search.
 *
 * THE OPTIONS COME FROM `LANGUAGE_OPTIONS` RATHER THAN FROM `SERVED_LANGUAGES`,
 * because this half renders in the browser and the served-languages module
 * imports the database schema at module scope. `tests/unit/language-pair.test.ts`
 * pins the two lists to the same codes, which is the half a type cannot see.
 */
function LanguageFilter({ from, to }: { from: string | null; to: string | null }) {
  const { t } = useTranslation();
  const fieldId = useId();
  const fromId = `${fieldId}-from`;
  const toId = `${fieldId}-to`;

  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className="text-xs text-muted-foreground">
          {t('browse.filterFromLabel')}
        </label>
        <select
          id={fromId}
          name="from"
          className={CONTROL_CLASS}
          key={`from-${from ?? ANY_LANGUAGE}`}
          defaultValue={from ?? ANY_LANGUAGE}
        >
          <option value={ANY_LANGUAGE}>{t('browse.filterAny')}</option>
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={toId} className="text-xs text-muted-foreground">
          {t('browse.filterToLabel')}
        </label>
        <select
          id={toId}
          name="to"
          className={CONTROL_CLASS}
          key={`to-${to ?? ANY_LANGUAGE}`}
          defaultValue={to ?? ANY_LANGUAGE}
        >
          <option value={ANY_LANGUAGE}>{t('browse.filterAny')}</option>
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-9')}>
        {t('browse.filterApply')}
      </button>
    </form>
  );
}

/**
 * The way in, for whoever is reading.
 *
 * A stranger is offered the two doors; a reader who already holds an account is
 * offered the product. Neither is a wall: the rows above render either way.
 */
function Doors({ isSignedIn }: { isSignedIn: boolean }) {
  const { t } = useTranslation();

  if (isSignedIn) {
    return (
      <Link to="/" className="text-sm underline underline-offset-4">
        {t('browse.backToApp')}
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-4">
      <p className={QUIET_LINE}>{t('browse.doorsBody')}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Link to={SIGN_UP_PATH} className={cn(buttonVariants(), 'h-11 w-full sm:w-auto')}>
          {t('welcome:createAction')}
        </Link>
        <Link to={SIGN_IN_PATH} className={cn(buttonVariants({ variant: 'outline' }), 'h-11 w-full sm:w-auto')}>
          {t('welcome:signInAction')}
        </Link>
      </div>
    </div>
  );
}

export default function BrowseExplanationsRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { rows, total, shown, nextPage, from, to, isSignedIn } = loaderData;

  return (
    <PublicWrapper>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{t('browse.heading')}</h1>
          <p className={QUIET_LINE}>
            {t('browse.licence')}{' '}
            <a href={CC0_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              {t('browse.licenceLink')}
            </a>
          </p>
          <p className={QUIET_LINE}>{t('browse.machineNote')}</p>
        </div>

        <LanguageFilter from={from} to={to} />

        {rows.length === 0 && (
          <div className="surface-brand-soft rounded-xl border border-dashed p-6">
            <h2 className="font-display text-base font-semibold">{t('browse.emptyTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('browse.emptyBody')}</p>
          </div>
        )}

        {rows.length > 0 && (
          <div className="flex flex-col gap-3">
            <ul>
              {rows.map((row) => (
                <BrowseRow key={row.id} row={row} />
              ))}
            </ul>

            {/* A LINK, NOT A BUTTON, because it goes somewhere: the wider window
                is a URL. It carries the filter with it, or pressing it would
                widen the window and silently drop the languages the reader
                chose. It says how many of how many are on screen. */}
            {nextPage !== null && (
              <div className="px-3">
                <Link to={windowHref({ from, to, page: nextPage })} className="text-sm underline underline-offset-4">
                  {t('explanations.showMore', { shown, total })}
                </Link>
              </div>
            )}
          </div>
        )}

        <Doors isSignedIn={isSignedIn} />
      </div>
    </PublicWrapper>
  );
}
