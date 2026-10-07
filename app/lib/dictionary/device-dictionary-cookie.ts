/**
 * device-dictionary-cookie.ts, which device dictionaries this browser holds,
 * mirrored into a cookie so the SERVER can read the list.
 *
 * WHY A COOKIE WHEN THE DICTIONARY LIVES IN INDEXEDDB. The device dictionary
 * itself never leaves the browser: it is hundreds of thousands of share-alike
 * rows the reader brought from the upstream project, and the milestone's whole
 * point is that Kenning does not host, serve or store them. But the server has
 * one decision that depends on whether a dictionary exists: whether a search for
 * a word should queue a paid model call at once or wait for the reader to ask.
 * That decision is made in the loader, before the page reaches the browser, so
 * the loader needs to know which directions have a device dictionary.
 *
 * WHAT THE COOKIE CARRIES IS THE LIST OF PAIRS AND NOTHING ELSE. A value such as
 * `de-en,en-de` names two directions. No word, no count, no file name and no
 * byte of the dictionary is in it. That is also the most this module may ever
 * carry: the invariant of the milestone is that no imported byte reaches the
 * server, and a pair list is the one fact the server is allowed to learn.
 *
 * THIS FILE LIVES OUTSIDE `app/lib/local-dictionary/` ON PURPOSE. That directory
 * is client-only and no server module imports it. This file is the single part
 * of the feature the server DOES import, so it sits beside `language-pair.ts`,
 * which it mirrors, and it imports nothing but that module and a type.
 *
 * THE DIRECTED PAIR KEY. A dictionary is directional: `en-de` answers English
 * words with German ones and says nothing about the reverse. The key is the two
 * codes joined by a hyphen, exactly the shape of a WikDict file name without its
 * extension, and it is the one definition of that key: the store, the file name
 * parser and this cookie all go through `deviceDictionaryPairKey`.
 *
 * NOT httpOnly: the client writes it and no server action ever does.
 *
 * Client- and server-safe: plain TS, no `document` access at module scope. The
 * client helper guards `document` itself, so this file is import-safe under SSR.
 */

import type { LanguageCode } from './detect-language';
import { isPairLanguage } from './language-pair';

/** Where the list of imported pairs is mirrored for the server to read. */
export const DEVICE_DICTIONARY_COOKIE = 'device-dict';

/** 1 year, a durable per-device fact, like the language pair and the theme. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The separator between pairs inside the cookie value. */
const PAIR_SEPARATOR = ',';

/** Two lowercase codes and a hyphen. Whether the codes are served is checked after. */
const PAIR_KEY_PATTERN = /^(?<from>[a-z]{2})-(?<to>[a-z]{2})$/u;

/** The two sides of a directed pair, both known to be served languages. */
export interface DeviceDictionaryPair {
  from: LanguageCode;
  to: LanguageCode;
}

/**
 * The key of one directed pair, such as `en-de`.
 *
 * @param from The language of the words that are looked up.
 * @param to The language of the words that come back.
 */
export function deviceDictionaryPairKey(from: LanguageCode, to: LanguageCode): string {
  return `${from}-${to}`;
}

/**
 * Read a pair key back into its two languages.
 *
 * It answers `null` for everything that is not exactly two SERVED, DIFFERENT
 * languages. That is the same gate the cookie parser applies, so a key that
 * passes here is one every other module may trust without checking again.
 *
 * @param value A candidate key, from a cookie, a store or a file name.
 * @returns The pair, or `null` when the value names no served direction.
 */
export function parseDeviceDictionaryPairKey(value: string): DeviceDictionaryPair | null {
  const groups = PAIR_KEY_PATTERN.exec(value)?.groups;
  if (groups === undefined) return null;
  const { from, to } = groups;
  if (!isPairLanguage(from) || !isPairLanguage(to)) return null;
  if (from === to) return null;
  return { from, to };
}

/**
 * The pairs as one cookie value: sorted, without repeats, joined by commas.
 *
 * SORTED SO THE VALUE IS STABLE. Two devices that imported the same files in a
 * different order write the same cookie, and a test can compare strings.
 * Anything that is not a served direction is dropped, so this can never write a
 * value its own parser would then refuse.
 *
 * @param pairs Pair keys, in any order. Repeats and invalid keys are tolerated.
 */
export function serializeDeviceDictionaryPairs(pairs: Iterable<string>): string {
  const valid = [...new Set(pairs)].filter((pair) => parseDeviceDictionaryPairKey(pair) !== null);
  return valid.toSorted().join(PAIR_SEPARATOR);
}

/** Read one named cookie out of a raw `Cookie` header. Mirrors `language-pair.ts`. */
function readCookieFromHeader(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A stray `%` makes the value undecodable. It is somebody else's garbage
      // in a cookie we name, and "no dictionary" is the safe reading of it.
      return undefined;
    }
  }
  return undefined;
}

/**
 * SERVER: the pairs this browser says it holds a device dictionary for.
 *
 * Never throws. An absent cookie, an undecodable one, and every entry that is
 * not two served, different languages (`en-en`, `fr-de`, `EN-DE`, `en-de-es`)
 * read as "no dictionary" rather than as a pair the loader would act on. A
 * stale cookie from a language this app has stopped serving must not make the
 * server hold a model call back for a dictionary that cannot exist.
 *
 * THE COOKIE IS A CLAIM, NOT A PROOF. Anyone can write it, so the server may use
 * it only for a decision where being lied to costs nothing: holding back a call
 * the reader can press a button to run.
 *
 * @param header The request's raw `Cookie` header, or `null`.
 */
export function parseDeviceDictionaryCookie(header: string | null): ReadonlySet<string> {
  const raw = readCookieFromHeader(header, DEVICE_DICTIONARY_COOKIE);
  if (raw === undefined) return new Set();
  const pairs = raw.split(PAIR_SEPARATOR).filter((pair) => parseDeviceDictionaryPairKey(pair) !== null);
  return new Set(pairs);
}

/**
 * CLIENT: mirror the pair list into the cookie, so the next request's loader
 * already knows it. No-op on the server.
 *
 * 1 year, `Path=/`, `SameSite=Lax`, and not httpOnly, written the way
 * `writeLanguagePairCookie` writes the language pair and for the same reason.
 * An empty list writes an empty value, which the parser reads as no pairs.
 *
 * @param pairs Pair keys for every dictionary the device holds.
 */
export function writeDeviceDictionaryCookie(pairs: Iterable<string>): void {
  if (globalThis.document === undefined) return;
  document.cookie = `${DEVICE_DICTIONARY_COOKIE}=${serializeDeviceDictionaryPairs(pairs)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}
