/**
 * plan-on-device.ts, the one door between the search route and the device
 * dictionary engine, for the offline case.
 *
 * WHY A DOOR AND NOT AN IMPORT IN THE ROUTE. `translate.tsx` is a route, and
 * routes are the files this repo's tripwires watch most closely for the device
 * dictionary: the history recorder, the favourite star and the loader's data are
 * all one function call from it (ADR-0013). Keeping the route off the engine
 * allow-lists means a route can never be handed a dictionary entry by accident.
 * This file is the single new importer, it is named on both allow-lists in
 * `tests/unit/device-dictionary-never-reaches-server.test.ts` and
 * `device-dictionary-hit-stays-local.test.ts`, and what it hands back is
 * {@link OfflineSearchPlan}: routing facts, never an entry.
 *
 * CLIENT ONLY. It opens IndexedDB, so it may be called from a client loader,
 * an effect or a handler, and never from a server render.
 */
import { openDeviceStorage } from '#app/lib/local-dictionary/device-storage';
import {
  NO_DICTIONARIES,
  planOfflineSearch,
  type OfflineSearchInput,
  type OfflineSearchPlan,
} from '#app/lib/local-dictionary/offline-search';
import { reportError } from '#app/lib/report-error';

/**
 * Work out what the offline search screen draws, from this device alone.
 *
 * It never rejects. A browser that blocks IndexedDB (a private window, cleared
 * site data) simply has no dictionary, and the screen says so. The failure is
 * reported WITHOUT the query: the typed word is the one thing that must not ride
 * along into a log line.
 *
 * @param input The typed text, the URL's language parameters and this device's cookie string.
 * @returns The plan: pair, direction, whether the text is a phrase, and which dictionaries exist.
 */
export async function planOnDevice(input: OfflineSearchInput): Promise<OfflineSearchPlan> {
  try {
    return await planOfflineSearch(openDeviceStorage(), input);
  } catch (cause) {
    reportError(cause, { stage: 'plan-offline-search' });
    return planOfflineSearch(NO_DICTIONARIES, input);
  }
}
