/**
 * offline-search.ts, which screen a search draws when the app server cannot be
 * reached and the only dictionary left is the one on this device.
 *
 * WHAT THIS DECIDES, AND WHAT IT MUST NOT RETURN. The search route's
 * `clientLoader` answers from the device when the network is gone. The result
 * becomes loader data, and loader data is the one thing in this app that travels
 * between modules freely (history, favourites, the sync blob and every prompt
 * are all one function call from it). The device dictionary is a share-alike
 * word list that must reach none of them (ADR-0013). So this module returns
 * ROUTING FACTS only: the language pair, the direction, whether the text is a
 * phrase, and which dictionaries are on the device by name and size. It reads
 * the store to PICK a direction, which is allowed, and it never returns what it
 * read. `tests/unit/device-dictionary-never-reaches-server.test.ts` reads this
 * file's result type to prove it names no entry.
 *
 * THE DIRECTION, IN THE ORDER THE SERVER WOULD DECIDE IT
 *   1. The pair is the URL first, then the pair this device last chose, then the
 *      default. It is the SAME `resolveLanguagePair` the server runs, fed the
 *      device's own copy of the pair cookie instead of a request header, so the
 *      precedence and the repair of a source that equals its target cannot drift.
 *   2. A stated source is the direction.
 *   3. A source of `detect` cannot be detected here: detection counts hits in the
 *      server's corpus, which is exactly what is out of reach. What can be asked
 *      is the device's own dictionaries. They are tried with those that translate
 *      INTO the chosen target first, and the first one that holds the word wins.
 *      With no hit anywhere, the first dictionary into the target is the
 *      direction, and with none of those, the partner of the target language
 *      (the server's own fallback rule), so the screen can say the word is not on
 *      this device instead of claiming a direction nobody imported.
 *
 * LOGIC OVER THE SMALL INTERFACE, like the store it reads. Everything is written
 * against {@link DictionaryStorage} so the unit tests drive it with an in-memory
 * object and need no browser.
 */

import type { Direction } from '#app/lib/dictionary/detect-language';
import {
  DETECT,
  partnerLanguage,
  reconcilePairWithDirection,
  resolveLanguagePair,
  type LanguagePair,
} from '#app/lib/dictionary/language-pair';
import { normalizeQuery } from '#app/lib/dictionary/normalize';
import type { OfflineDictionaryInfo } from '#app/lib/offline/offline-view';
import {
  listImportedDictionaries,
  lookupDeviceEntry,
  type DictionaryMeta,
  type DictionaryStorage,
} from './device-dictionary-store';

/** What {@link planOfflineSearch} reads. */
export interface OfflineSearchInput {
  /** The query as typed, already trimmed. Empty for the screen with nothing searched. */
  q: string;
  /** The `from` search parameter as it arrived, or `null`. */
  urlFrom: string | null;
  /** The `to` search parameter as it arrived, or `null`. */
  urlTo: string | null;
  /** This device's own cookie string, which carries the pair it last chose, or `null`. */
  cookieHeader: string | null;
}

/**
 * What the offline search screen is told. Routing facts, and no dictionary text.
 *
 * Every field is a language code, a count or a flag. There is deliberately no
 * field that could hold a word, a translation or an entry.
 */
export interface OfflineSearchPlan {
  /** The pair the language bar shows, reconciled with the direction once something was searched. */
  pair: LanguagePair;
  /** The direction the device lookup runs in. */
  direction: Direction;
  /** Whether the typed text is two or more words, which the device dictionary never answers. */
  isPhrase: boolean;
  /** The dictionaries on this device, by name and size. */
  dictionaries: OfflineDictionaryInfo[];
}

/**
 * A device that holds nothing, for the caller whose storage could not be opened.
 *
 * A browser that blocks IndexedDB (a private window, cleared site data) has no
 * dictionary to offer, and the screen should say so rather than fail. Passing
 * this to {@link planOfflineSearch} gives exactly that plan.
 */
export const NO_DICTIONARIES: DictionaryStorage = {
  async putBatch() {
    // Nothing is ever written through this stand-in.
  },
  async getEntry() {
    return null;
  },
  async getMeta() {
    return null;
  },
  async listMeta() {
    return [];
  },
  async deletePair() {
    // Nothing is ever held, so nothing is deleted.
  },
};

/**
 * The imported dictionaries in the order the direction picker tries them: those
 * that translate into the target first, then the rest, each group in pair order.
 *
 * @param metas Every dictionary on the device, in any order.
 * @param target The language the reader wants translations in.
 */
export function orderDictionariesForTarget(metas: readonly DictionaryMeta[], target: string): DictionaryMeta[] {
  const sorted = metas.toSorted((left, right) => left.pair.localeCompare(right.pair));
  return [...sorted.filter((meta) => meta.to === target), ...sorted.filter((meta) => meta.to !== target)];
}

/** What {@link pickDetectedDirection} reads. */
interface DetectedDirectionInput {
  storage: DictionaryStorage;
  metas: readonly DictionaryMeta[];
  q: string;
  target: LanguagePair['target'];
}

/**
 * Choose a direction for a search whose source is `detect`.
 *
 * It asks each dictionary on the device, best candidate first, whether it holds
 * the word, and keeps only WHICH ONE answered. The entry itself is dropped on the
 * spot: reading the store to pick a direction is allowed, returning what it read
 * is not.
 *
 * @param input The storage, the dictionaries, the typed text and the target.
 * @returns The direction of the first dictionary holding the word, else the first
 *   dictionary into the target, else the partner of the target.
 */
async function pickDetectedDirection({ storage, metas, q, target }: DetectedDirectionInput): Promise<Direction> {
  const candidates = orderDictionariesForTarget(metas, target);
  for (const candidate of candidates) {
    const hit = await lookupDeviceEntry(storage, { pair: candidate.pair, from: candidate.from, query: q });
    if (hit !== null) return { from: candidate.from, to: candidate.to, detected: true };
  }
  const intoTarget = candidates.find((candidate) => candidate.to === target);
  if (intoTarget !== undefined) return { from: intoTarget.from, to: intoTarget.to, detected: true };
  return { from: partnerLanguage(target), to: target, detected: true };
}

/**
 * Work out what the offline search screen should draw.
 *
 * @param storage The device dictionary storage. Reads only.
 * @param input The typed text, the URL's language parameters and the device's pair cookie.
 * @returns The pair, the direction, whether the text is a phrase and which
 *   dictionaries exist. Never a word, a translation or an entry.
 * @throws Whatever the storage throws. A caller whose storage cannot be opened
 *   passes {@link NO_DICTIONARIES} instead.
 */
export async function planOfflineSearch(storage: DictionaryStorage, input: OfflineSearchInput): Promise<OfflineSearchPlan> {
  const { q, urlFrom, urlTo, cookieHeader } = input;
  const pair = resolveLanguagePair({ from: urlFrom, to: urlTo, cookieHeader });
  const metas = await listImportedDictionaries(storage);

  const direction: Direction =
    pair.source === DETECT ?
      await pickDetectedDirection({ storage, metas, q, target: pair.target })
    : { from: pair.source, to: pair.target, detected: false };

  return {
    // The bar shows the side the search used, once one ran. With nothing typed no
    // search ran, so there is nothing to reconcile against (the server's rule).
    pair: q === '' ? pair : reconcilePairWithDirection(pair, direction),
    direction,
    isPhrase: normalizeQuery(q, direction.from).isPhrase,
    dictionaries: metas.map((meta) => ({
      pair: meta.pair,
      from: meta.from,
      to: meta.to,
      entryCount: meta.entryCount,
    })),
  };
}
