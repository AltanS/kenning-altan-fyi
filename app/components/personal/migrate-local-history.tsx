import { useEffect } from 'react';
import { clearHistory, listHistory } from '#app/lib/local-store';
import { reportError } from '#app/lib/report-error';

/**
 * Hands this device's old search log to the server, once, and then drops it.
 *
 * WHY IT EXISTS. The log used to live only in the browser. It lives in
 * `search_history` now, so a reader who has been using this app already holds
 * rows in a place nothing reads any more. Deleting them silently would be
 * taking a person's history away as the price of an improvement they did not
 * ask for. This uploads them first.
 *
 * IT IS NOT A SYNC, AND IT RUNS AT MOST ONCE PER DEVICE. It reads the local
 * table, posts what it finds, and clears it. An empty table means there is
 * nothing to hand over and nothing happens, which is every device from the
 * second load onwards and every device that never had a log.
 *
 * THE INSTANTS TRAVEL WITH THE ROWS. Each entry carries its own `at`, so a
 * month of searching arrives as a month of searching rather than as five
 * hundred rows recorded in one second.
 *
 * THE LOCAL TABLE IS CLEARED ONLY AFTER THE POST SUCCEEDS. A failed upload
 * leaves the rows where they are, so the next load tries again rather than
 * losing them between the two stores.
 *
 * IT IS TEMPORARY. Once the devices in use have handed their logs over, this
 * component and the local history module behind it can both go. Until then it
 * is the only reader of that module outside backup and restore.
 *
 * Renders nothing.
 */
export function MigrateLocalHistory(): null {
  useEffect(() => {
    const handOver = async (): Promise<void> => {
      const entries = await listHistory();
      if (entries.length === 0) return;

      const response = await fetch('/api/search-history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: entries.map((entry) => ({
            query: entry.query,
            from: entry.from,
            to: entry.to,
            headwordId: entry.headwordId,
            translation: entry.translation,
            at: entry.at,
          })),
        }),
      });
      if (!response.ok) throw new Error(`Handing over the local log answered ${response.status}`);

      await clearHistory();
    };

    handOver().catch((cause) => {
      // The rows stay where they are, and the next load tries again. A failed
      // handover must not be an error on a screen the reader came to search on.
      reportError(cause, { scope: 'migrate-local-history' });
    });
  }, []);

  return null;
}
