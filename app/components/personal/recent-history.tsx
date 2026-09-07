import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { repeatSearchHref, SavedWordRow } from '#app/components/personal/saved-word-row';
import { formatRelativeTime } from '#app/lib/relative-time';

/** How many recorded searches the overview shows. The whole log is at `/history`. */
export const RECENT_HISTORY_COUNT = 5;

/** One recorded search, as the overview needs it. The shape the history screen renders, minus nothing. */
export interface RecentSearch {
  id: string;
  query: string;
  from: string;
  to: string;
  /** The answer this search got, or null when it was logged before one arrived. */
  translation: string | null;
  at: number;
}

/**
 * The last few searches this reader ran, under the translator on the overview.
 *
 * IT IS FED BY THE LOADER, NOT BY THE DEVICE. It read the browser's own store
 * in an effect while the log lived there, which meant it could not exist in the
 * first byte of HTML and flashed in after hydration. The rows are in
 * `search_history` now, so the server renders them with the rest of the screen
 * and there is no second state to hold. Why the log moved at all is argued at
 * the top of `drizzle/schema/search-history.ts` and recorded in ADR-0011.
 *
 * AN EMPTY LOG SHOWS NOTHING, not an empty card explaining itself. A reader who
 * has searched nothing yet is looking at a search box, which already says what
 * to do.
 *
 * ONE INSTANT FOR THE WHOLE BLOCK, taken in the loader rather than during
 * render, so the five rows are all measured against the same moment.
 *
 * THE ROW IS `SavedWordRow`, the same row `/history` and `/favourites` print. A
 * shortened list of a screen the reader can also open in full has to look like
 * that screen, or the two read as two different records.
 *
 * IT IS PURE OVER ITS PROPS, which is what lets the surface be rendered for
 * somebody with no session without reading or writing anything of theirs.
 */
export function RecentHistory({ entries, nowMs }: { entries: readonly RecentSearch[]; nowMs: number }) {
  const { t, i18n } = useTranslation();

  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="recent-history-title" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 px-3">
        <h2 id="recent-history-title" className="font-display text-base font-semibold">
          {t('history.recentTitle')}
        </h2>
        <Link to="/history" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
          {t('history.recentAll')}
        </Link>
      </div>
      {/* Set as quietly as the history screen sets it: no card and no shadow,
          rows separated by a hairline. */}
      <ul>
        {entries.map((entry) => (
          <SavedWordRow
            key={entry.id}
            term={entry.query}
            answer={entry.translation}
            from={entry.from}
            to={entry.to}
            href={repeatSearchHref({ term: entry.query, from: entry.from, to: entry.to })}
            ariaLabel={t('history.repeat', { query: entry.query })}
            trailing={
              <time dateTime={new Date(entry.at).toISOString()} className="text-xs text-muted-foreground tabular-nums">
                {formatRelativeTime(entry.at, nowMs, i18n.language)}
              </time>
            }
          />
        ))}
      </ul>
    </section>
  );
}
