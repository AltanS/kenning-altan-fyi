/**
 * use-device-dictionary-hit.ts, the search screen's look into the dictionary the
 * reader keeps on this device (M208/03).
 *
 * THE LOOKUP NEVER RUNS DURING RENDER AND NEVER ON THE SERVER. IndexedDB does not
 * exist while the server renders, and reading it in a render would make the
 * first client render differ from the server's. So the hook is a small state
 * machine over an effect: it reports `loading` from the first render, `idle`
 * when it is switched off, and settles to `hit` or `miss` once the effect has
 * read the store. The server and the first client render therefore agree.
 *
 * A STALE ANSWER IS NEVER SHOWN FOR A NEW SEARCH. The settled result is kept with
 * the key it was read for, and {@link currentDeviceLookup} reports `loading`
 * whenever that key is not the current one. That matters more than a flicker: the
 * screen asks the AI by itself on a `miss`, so a miss left over from the previous
 * word must never be read as the answer for this one. The effect's `ignore` flag
 * covers the other half, a slow read that finishes after the search has moved on.
 *
 * THE HIT STAYS IN THIS HOOK'S CALLER. It is returned to the one component that
 * draws the device card and to nobody else: not the history recorder, not the
 * favourite star, not a loader, an action or any request. Nothing in this file
 * reaches the network, and `tests/unit/local-dictionary-store.test.ts` fails the
 * build if it ever does.
 */

import { useEffect, useState } from 'react';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { deviceDictionaryPairKey } from '#app/lib/dictionary/device-dictionary-cookie';
import { reportError } from '#app/lib/report-error';
import {
  createIndexedDbStorage,
  lookupDeviceEntry,
  type DeviceDictionaryEntry,
  type DictionaryMeta,
  type DictionaryStorage,
} from './device-dictionary-store';

/** What the device dictionary knows about the searched word. */
export type DeviceDictionaryLookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'hit'; entry: DeviceDictionaryEntry; meta: DictionaryMeta }
  | { status: 'miss' };

/** What a lookup settles to, which is the two outcomes of a finished read. */
export type SettledDeviceLookup = Extract<DeviceDictionaryLookup, { status: 'hit' | 'miss' }>;

/** The search a lookup is for. */
export interface DeviceLookupSearch {
  /** The language the word is written in. */
  from: LanguageCode;
  /** The language its translations are wanted in. */
  to: LanguageCode;
  /** The text as typed. The store normalises it. */
  q: string;
}

/** A settled result and the search it belongs to. */
export interface KeyedDeviceLookup {
  key: string;
  result: SettledDeviceLookup;
}

/** What {@link useDeviceDictionaryHit} takes. */
export interface UseDeviceDictionaryHitOptions extends DeviceLookupSearch {
  /** False switches the lookup off: nothing is opened and the hook reports `idle`. */
  enabled: boolean;
}

/** What {@link currentDeviceLookup} reads. */
export interface CurrentDeviceLookupOptions {
  enabled: boolean;
  /** {@link deviceLookupKey} for the search on screen now. */
  key: string;
  /** The most recent settled result, with the key it was read for. */
  settled: KeyedDeviceLookup | null;
}

/**
 * The identity of one lookup: the direction and the text.
 *
 * A NUL CANNOT OCCUR IN EITHER HALF, so two different searches cannot collide
 * into one key.
 *
 * @param search The direction and the typed text.
 */
export function deviceLookupKey({ from, to, q }: DeviceLookupSearch): string {
  return `${deviceDictionaryPairKey(from, to)}\u0000${q}`;
}

/**
 * What the screen should believe right now.
 *
 * @param options Whether the lookup is on, the key of the search on screen, and the
 *   last settled result.
 * @returns `idle` when off, `loading` when the settled result is for another
 *   search or there is none yet, otherwise the settled result.
 */
export function currentDeviceLookup({ enabled, key, settled }: CurrentDeviceLookupOptions): DeviceDictionaryLookup {
  if (!enabled) return { status: 'idle' };
  if (settled === null || settled.key !== key) return { status: 'loading' };
  return settled.result;
}

/**
 * Read the dictionary for one search and settle to a hit or a miss.
 *
 * EVERY FAILURE IS A MISS. A browser that cannot open IndexedDB (private mode,
 * storage cleared, a blocked upgrade), a dictionary the reader removed after the
 * cookie was written, or a pair that was never imported all mean the same thing to
 * the screen: the device has nothing for this word, so the AI runs as it did
 * before. The cause is reported to the console sink and never shown. The report
 * carries the failure and no word, so a hit or a query cannot leave through it.
 *
 * @param openStorage Opens the storage. Called inside the guard, so a missing
 *   `indexedDB` is a miss like any other failure.
 * @param search The direction and the typed text.
 * @returns `hit` with the entry and the dictionary's meta, or `miss`.
 */
export async function settleDeviceLookup(
  openStorage: () => DictionaryStorage,
  { from, to, q }: DeviceLookupSearch,
): Promise<SettledDeviceLookup> {
  try {
    const hit = await lookupDeviceEntry(openStorage(), { pair: deviceDictionaryPairKey(from, to), from, query: q });
    return hit === null ? { status: 'miss' } : { status: 'hit', entry: hit.entry, meta: hit.meta };
  } catch (cause) {
    reportError(cause, { stage: 'lookup-device-dictionary' });
    return { status: 'miss' };
  }
}

/** The browser's storage, opened on first use inside an effect and never during a render. */
let deviceStorage: DictionaryStorage | undefined;

/** The device dictionary's IndexedDB storage. Call from an effect or a handler only. */
function openDeviceStorage(): DictionaryStorage {
  deviceStorage ??= createIndexedDbStorage();
  return deviceStorage;
}

/**
 * Look the searched word up in the dictionary this device holds for the direction.
 *
 * @param options Whether to look, and the direction and text to look for.
 * @returns Where the lookup stands. `idle` when disabled, `loading` until the
 *   effect has read the store (including on the server), then `hit` or `miss`.
 */
export function useDeviceDictionaryHit({
  enabled,
  from,
  to,
  q,
}: UseDeviceDictionaryHitOptions): DeviceDictionaryLookup {
  const [settled, setSettled] = useState<KeyedDeviceLookup | null>(null);
  const key = deviceLookupKey({ from, to, q });

  useEffect(() => {
    if (!enabled) return;
    let ignore = false;
    const read = async (): Promise<void> => {
      const result = await settleDeviceLookup(openDeviceStorage, { from, to, q });
      if (!ignore) setSettled({ key, result });
    };
    void read();
    return () => {
      ignore = true;
    };
  }, [enabled, key, from, to, q]);

  return currentDeviceLookup({ enabled, key, settled });
}
