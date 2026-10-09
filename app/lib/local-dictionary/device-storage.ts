/**
 * device-storage.ts, the one IndexedDB handle the lookup paths share.
 *
 * Two callers read the device dictionary: the hook behind the search screen's
 * device card, and the offline search planner that picks a direction before the
 * screen renders. Both ask for the same database, and opening it twice would be
 * two connections to read one store. This module opens it once, on first use.
 *
 * IT MUST BE CALLED FROM AN EFFECT, A HANDLER OR A CLIENT LOADER, never during a
 * render. `indexedDB` does not exist while the server renders, and
 * `createIndexedDbStorage` reads it when it is called, so the module itself is
 * safe to import on the server and the call is not safe to make there.
 */

import { createIndexedDbStorage, type DictionaryStorage } from './device-dictionary-store';

/** The browser's storage, opened on first use. */
let deviceStorage: DictionaryStorage | undefined;

/** The device dictionary's IndexedDB storage. Call from an effect, a handler or a client loader only. */
export function openDeviceStorage(): DictionaryStorage {
  deviceStorage ??= createIndexedDbStorage();
  return deviceStorage;
}
