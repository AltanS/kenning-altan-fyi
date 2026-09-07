import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { repeatSearchHref, SavedWordRow } from '#app/components/personal/saved-word-row';
import { listHistory, type LocalHistoryEntry } from '#app/lib/local-store';
import { formatRelativeTime } from '#app/lib/relative-time';
import { reportError } from '#app/lib/report-error';

/** How many recorded searches the home screen shows. The whole log is at `/history`. */
export const RECENT_HISTORY_COUNT = 5;

/** The newest few searches, in the order `listHistory` already returns them. */
export function takeRecent(entries: readonly LocalHistoryEntry[]): LocalHistoryEntry[] {
  return entries.slice(0, RECENT_HISTORY_COUNT);
}

/**
 * The last few searches this device ran, under the translator on the home
 * screen.
 *
 * IT RENDERS NOTHING ON THE SERVER, AND NOTHING ON A FIRST PAINT, for the
 * reason `DailyNudge` does: the log is a table in this browser's own store, so
 * the server has neither the data nor the permission to hold it. The HTML this
 * route sends is unchanged by this component existing.
 *
 * AN EMPTY LOG SHOWS NOTHING, not an empty card explaining itself. A reader who
 * has searched nothing yet is looking at a search box, which already says what
 * to do.
 *
 * ONE INSTANT FOR THE WHOLE BLOCK, taken beside the entries rather than during
 * render, so the five rows are all measured against the same moment.
 *
 * THE ROW IS `SavedWordRow`, the same row `/history` and `/favourites` print. A
 * shortened list of a screen the reader can also open in full has to look like
 * that screen, or the two read as two different records.
 */
export function RecentHistory() {
  const { t, i18n } = useTranslation();
  const [recent, setRecent] = useState<{ entries: LocalHistoryEntry[]; nowMs: number } | null>(null);

  useEffect(() => {
    let isCurrent = true;

    const read = async (): Promise<void> => {
      const entries = await listHistory();
      if (!isCurrent) return;
      setRecent({ entries: takeRecent(entries), nowMs: Date.now() });
    };

    read().catch((cause) => {
      // A log that cannot be read is not worth an error on the home screen.
      // The search box above it is why the reader is here.
      reportError(cause, { scope: 'recent-history' });
    });

    return () => {
      isCurrent = false;
    };
  }, []);

  if (recent === null || recent.entries.length === 0) return null;

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
        {recent.entries.map((entry) => (
          <SavedWordRow
            key={entry.id}
            term={entry.query}
            answer={entry.translation}
            from={entry.from}
            to={entry.to}
            href={repeatSearchHref({ term: entry.query, from: entry.from, to: entry.to })}
            ariaLabel={t('history.repeat', { query: entry.query })}
            trailing={
              <time
                dateTime={new Date(entry.at).toISOString()}
                className="text-xs text-muted-foreground tabular-nums"
              >
                {formatRelativeTime(entry.at, recent.nowMs, i18n.language)}
              </time>
            }
          />
        ))}
      </ul>
    </section>
  );
}
