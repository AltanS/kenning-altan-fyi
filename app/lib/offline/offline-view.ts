/**
 * offline-view.ts, the two shapes the search screen needs to draw itself offline.
 *
 * THESE ARE ROUTING FACTS AND NOTHING ELSE. Offline, the search route answers
 * from the device (`translate.tsx`'s `clientLoader`), and the device dictionary
 * is the reader's own copy of a share-alike word list that must never leave the
 * device or be handed anywhere a request could carry it (ADR-0013). So what the
 * route's loader data may hold is only what it needs to decide WHICH screen to
 * draw: whether the typed text is a phrase, and which dictionaries exist, named
 * by direction and size. Not a word, not a translation, not a hit.
 *
 * THIS FILE IMPORTS NOTHING FROM THE DEVICE DICTIONARY ENGINE, on purpose. The
 * components that draw the offline screen import these types, and a component
 * that imports the engine has to be on the allow-lists in
 * `tests/unit/device-dictionary-never-reaches-server.test.ts`. A plain data
 * shape keeps them off it.
 */
import type { LanguageCode } from '#app/lib/dictionary/detect-language';

/** What the screen may say about one dictionary on this device. No word of it. */
export interface OfflineDictionaryInfo {
  /** The directed pair key, such as `de-en`. */
  pair: string;
  from: LanguageCode;
  to: LanguageCode;
  /** How many words it holds, for the line under its name. */
  entryCount: number;
}

/** What `SearchPanes` is told when the search was answered from the device. */
export interface OfflineView {
  /** Whether the typed text is a phrase, which the device dictionary never answers. */
  isPhrase: boolean;
  /** The dictionaries on this device, for the empty screen. */
  dictionaries: readonly OfflineDictionaryInfo[];
}

/** The status of the device lookup, copied here so this file stays free of the engine. */
export type OfflineLookupStatus = 'idle' | 'loading' | 'hit' | 'miss';

/**
 * Which calm screen the offline result region draws.
 *
 * - `overview`: nothing was searched. Says what offline search can do and lists
 *   the dictionaries on this device.
 * - `phrase`: two or more words. The device dictionary answers one word, and a
 *   sentence needs the model, which needs a connection.
 * - `no-dictionary`: no dictionary on this device translates this way.
 * - `checking`: the lookup has not settled. Draws nothing, so a miss does not
 *   flash before a hit.
 * - `answered`: the device dictionary has the word. The hit card carries it.
 * - `miss`: the dictionary for this direction does not hold the word.
 */
export type OfflineResultKind = 'overview' | 'phrase' | 'no-dictionary' | 'checking' | 'answered' | 'miss';

/** What {@link offlineResultKind} reads. */
export interface OfflineResultInputs {
  /** The query as typed. Empty for the overview. */
  q: string;
  /** The direction the search ran in. */
  direction: { from: LanguageCode; to: LanguageCode };
  /** The routing facts the client loader produced. */
  offline: OfflineView;
  /** Where the device lookup stands. */
  lookup: OfflineLookupStatus;
}

/**
 * Decide which calm screen to draw.
 *
 * @param inputs The query, the direction, the routing facts and the lookup status.
 * @returns The screen. The order matters: a phrase and a missing dictionary are
 *   decided before the lookup, because the lookup cannot say anything about them.
 */
export function offlineResultKind({ q, direction, offline, lookup }: OfflineResultInputs): OfflineResultKind {
  if (q === '') return 'overview';
  if (offline.isPhrase) return 'phrase';
  const hasDictionary = offline.dictionaries.some(
    (dictionary) => dictionary.from === direction.from && dictionary.to === direction.to,
  );
  if (!hasDictionary) return 'no-dictionary';
  if (lookup === 'hit') return 'answered';
  if (lookup === 'miss') return 'miss';
  return 'checking';
}
