import type { Route } from './+types/history';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmAction } from '#app/components/confirm-action';
import { repeatSearchHref, SavedWordRow } from '#app/components/personal/saved-word-row';
import { Button } from '#app/components/ui/button';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { formatRelativeTime } from '#app/lib/relative-time';
import { clearSearchHistory, listSearchHistory } from '#app/models/search-history.server';
import { resolveUser } from '#app/middleware/auth';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'history.metaTitle') },
    { name: 'description', content: metaTitle(language, 'history.metaDescription') },
  ];
};

/**
 * The searches this reader has run.
 *
 * A SERVER LOADER, AND IT USED TO BE A CLIENT ONE. The log lived only in this
 * browser's store until the server table existed, so there was nothing for a
 * server loader to read and asking for one would have meant telling the server
 * what somebody looked up. Both halves of that changed: the rows are in
 * `search_history` now, and the server has always received the word anyway,
 * because it searches the dictionary with it. The argument in full is in
 * ADR-0011 and at the top of `drizzle/schema/search-history.ts`.
 *
 * WHAT THE READER GETS OUT OF THE MOVE is the only thing that justified it: the
 * log follows the account. A word looked up on a laptop is in the history on a
 * phone, which is what anybody means by "my history" and what a device-only
 * store could never do.
 *
 * `listSearchHistory` already returns newest first and the cap is applied at
 * the WRITE, so what is here is exactly what the account kept.
 *
 * One `now` for the whole page, taken here rather than during render, so every
 * row is measured against the same instant.
 *
 * THE ROUTE IS UNDER `_app.gated`, so `authMiddleware` has already refused a
 * signed-out request before this runs. `resolveUser` is read for the id, and
 * the null branch is a type narrowing rather than a second gate.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await resolveUser(request);
  if (user === null) return { entries: [], nowMs: Date.now() };

  const rows = await listSearchHistory(user.id);
  return {
    entries: rows.map((row) => ({
      id: String(row.id),
      query: row.query,
      from: row.fromLanguage,
      to: row.toLanguage,
      translation: row.translation,
      at: row.at.getTime(),
    })),
    nowMs: Date.now(),
  };
}

const INTENT = { CLEAR: 'clear' } as const;

const historyFormSchema = z.object({ intent: z.literal(INTENT.CLEAR) });

/**
 * Drops the whole log. A HARD delete, unlike every other delete in the personal
 * layer: there is no peer to converge with, so there is nothing for a tombstone
 * to tell. "Clear" here means cleared, and the rows are gone from the database
 * rather than marked.
 */
export async function action({ request }: Route.ActionArgs) {
  const user = await resolveUser(request);
  if (user === null) return { success: false, error: 'unauthenticated' };

  const parsed = historyFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };

  await clearSearchHistory(user.id);
  return { success: true };
}

interface HistoryEntryView {
  id: string;
  query: string;
  from: string;
  to: string;
  /** The answer this search got, or null when it was logged before one arrived. */
  translation: string | null;
  at: number;
}

/**
 * One recorded search, on the row both personal screens share.
 *
 * WHAT IS LOCAL TO THIS SCREEN IS THE INSTANT, and it is handed to the row as
 * its trailing element rather than built into it: a favourite is not a moment,
 * so a shared row that always printed a time would have to invent one for the
 * screen that has none.
 */
function HistoryRow({ entry, nowMs }: { entry: HistoryEntryView; nowMs: number }) {
  const { t, i18n } = useTranslation();

  return (
    <SavedWordRow
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
  );
}

export default function HistoryRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { entries, nowMs } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {entries.length === 0 && (
        <div className="surface-brand-soft rounded-xl border border-dashed p-6">
          <h2 className="font-display text-base font-semibold">{t('history.emptyTitle')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('history.emptyBody')}</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="flex flex-col gap-3">
          {/* History is chronological and repetitive, so it is set quieter than
              a list: no card and no shadow, just rows separated by a hairline. */}
          <ul>
            {entries.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} nowMs={nowMs} />
            ))}
          </ul>
          {/* THE CAP IS STATED, NOT HIDDEN. The log truncates itself on every
              write, and a reader who is never told that is left to notice their
              own searches going missing. */}
          <p className="px-3 text-xs text-muted-foreground">{t('history.capNote')}</p>
          <div className="px-3">
            <ConfirmAction
              trigger={
                <Button type="button" variant="outline" size="sm">
                  {t('history.clear')}
                </Button>
              }
              title={t('history.clearTitle')}
              description={t('history.clearBody')}
              confirmText={t('history.clearConfirm')}
              confirmPendingText={t('history.clearPending')}
              cancelText={t('lists.deleteCancel')}
              confirmVariant="destructive"
              formData={{ intent: INTENT.CLEAR }}
              // `onSuccess` runs on the action's own answer, so a clear that
              // failed says nothing rather than claiming an empty log.
              onSuccess={() => toast.success(t('history.clearedToast'))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
