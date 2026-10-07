/**
 * wikdict-downloads.ts, the twelve WikDict files a reader may fetch themself.
 *
 * LINKS, NEVER FETCHES. The upstream host sends no CORS header, so a browser
 * page cannot read these files, and the milestone's rule is that Kenning does
 * not host, proxy or cache them. The settings card renders each address as an
 * anchor the reader follows in their own tab. Nothing in this file, or anywhere
 * in app code, requests one.
 *
 * BUILT FROM THE SERVED LANGUAGES. One entry per ordered pair of two different
 * served languages, so a fifth language adds its own links the day it is served.
 * The sizes are a hand-kept constant read off the upstream host on 2026-10-07;
 * they are a hint for a reader on a phone plan, not a contract, and a pair with
 * no entry simply shows no size.
 */

import { SERVED_LANGUAGES, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { deviceDictionaryPairKey } from '#app/lib/dictionary/device-dictionary-cookie';

/** Where WikDict publishes its SQLite pair files, format version 2. */
const WIKDICT_SQLITE_BASE_URL = 'https://download.wikdict.com/dictionaries/sqlite/2/';

/** The project's home page, which the attribution links to. */
export const WIKDICT_HOME_URL = 'https://www.wikdict.com/';

/**
 * Approximate download size in megabytes, keyed by the directed pair key.
 * Rounded; read off the upstream host on 2026-10-07.
 */
const APPROXIMATE_MEGABYTES = {
  'en-de': 21,
  'en-tr': 8,
  'en-es': 16,
  'de-en': 27,
  'de-tr': 11,
  'de-es': 16,
  'tr-en': 4,
  'tr-de': 3,
  'tr-es': 2,
  'es-en': 11,
  'es-de': 7,
  'es-tr': 3,
} as const;

/** One file the reader can download from WikDict. */
export interface WikdictDownload {
  /** The directed pair key, such as `en-de`. */
  pair: string;
  from: LanguageCode;
  to: LanguageCode;
  /** The address of the file on the upstream host. */
  url: string;
  /** Rounded size, or `null` when this build does not know it. */
  megabytes: number | null;
}

/**
 * The approximate size of one pair's file.
 *
 * @param pair The directed pair key.
 * @returns Megabytes, or `null` when the pair is not in the table.
 */
function findApproximateMegabytes(pair: string): number | null {
  const known = Object.entries(APPROXIMATE_MEGABYTES).find(([key]) => key === pair);
  return known === undefined ? null : known[1];
}

/**
 * Every downloadable direction, in the order the language bar lists the languages.
 *
 * @returns Twelve entries for the four served languages.
 */
export function listWikdictDownloads(): WikdictDownload[] {
  return SERVED_LANGUAGES.flatMap((from) =>
    SERVED_LANGUAGES.filter((to) => to !== from).map((to) => {
      const pair = deviceDictionaryPairKey(from, to);
      return { pair, from, to, url: `${WIKDICT_SQLITE_BASE_URL}${pair}.sqlite3`, megabytes: findApproximateMegabytes(pair) };
    }),
  );
}
