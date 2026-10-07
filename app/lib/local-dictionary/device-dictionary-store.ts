/**
 * device-dictionary-store.ts, the on-device dictionary: import it, look a word
 * up in it, list it, remove it.
 *
 * WHERE THE BYTES LIVE, AND WHERE THEY MUST NOT. A device dictionary is the
 * reader's own copy of a share-alike word list, kept in the browser's own
 * IndexedDB database `kenning-device-dictionary`. It is deliberately NOT in
 * TinyBase. TinyBase is the app's local store and it SYNCS to the server inside
 * a blob capped at 2 MiB (`app/lib/local-store/blob-schema.ts`); a dictionary of
 * a hundred thousand words in there would break the cap, and would also hand the
 * server a data set the whole milestone exists to keep off it. Nothing in this
 * file imports TinyBase, a route, a model or `fetch`, and
 * `tests/unit/local-dictionary-store.test.ts` fails the build if that changes.
 *
 * LOGIC OVER A SMALL INTERFACE. IndexedDB does not exist in Node, and the
 * repository has no fake of it and may not gain one. So the behaviour that can
 * go wrong (batching, the order of writes, what a lookup does with a phrase, an
 * interrupted import) is written against {@link DictionaryStorage}, five
 * methods, and tested with an in-memory object. `createIndexedDbStorage` is the
 * browser implementation, kept as thin as a shell can be. It is the one part of
 * this file the unit tests cannot run.
 *
 * AN INTERRUPTED IMPORT MUST NOT LOOK FINISHED. A dictionary is written in
 * batches, and a tab can close between any two of them. The meta record is what
 * the settings screen lists and what the cookie advertises, so it is written
 * LAST, after the final batch. A half-written dictionary therefore has entries
 * and no meta: it is not listed, the lookup refuses it, and importing the same
 * pair again clears whatever was left before it starts.
 *
 * ONE DEFINITION OF A KEY. The index key was produced at import by
 * `normalizeForLanguage`. A lookup reads the reader's text with `normalizeQuery`,
 * which is `normalizeForLanguage` after the cleaning a search box needs (quotes
 * they pasted, a question mark they typed). The two meet at the same key for
 * every single word, and they are the same functions the server search uses.
 */

import { z } from 'zod';
import { PAIR_LANGUAGES } from '#app/lib/dictionary/language-pair';
import { parseDeviceDictionaryPairKey } from '#app/lib/dictionary/device-dictionary-cookie';
import { normalizeQuery } from '#app/lib/dictionary/normalize';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';

/** What the label on a WikDict hit says the data is. */
export const WIKDICT_SOURCE_NAME = 'WikDict';

/** The licence the WikDict data is published under. Attribution and share-alike apply. */
export const WIKDICT_LICENCE = 'CC BY-SA 4.0';

/** Entries written per IndexedDB transaction. */
export const IMPORT_BATCH_SIZE = 5000;

/** The IndexedDB database every device dictionary lives in. */
const DATABASE_NAME = 'kenning-device-dictionary';

/** The schema version of that database. */
const DATABASE_VERSION = 1;

/** Object store of {@link DictionaryMeta} records, keyed by `pair`. */
const META_STORE = 'meta';

/** Object store of entries, keyed by `[pair, key]`. */
const ENTRIES_STORE = 'entries';

/** One word of one dictionary, as the lookup returns it. */
export interface DeviceDictionaryEntry {
  /** The normalised word, which is what a query is compared with. */
  key: string;
  /** The spelling to show, taken from the highest-scoring source row. */
  written: string;
  /** Its translations, best first. */
  translations: string[];
  /** The source's own score for the entry. Higher is a more common word. */
  score: number;
}

/** What the device knows about one imported dictionary. */
export interface DictionaryMeta {
  /** The directed pair key, such as `en-de`. */
  pair: string;
  from: LanguageCode;
  to: LanguageCode;
  entryCount: number;
  /** Epoch milliseconds when the import finished. */
  importedAt: number;
  /** Who made the data, for the label on a hit. */
  sourceName: string;
  /** The licence of the data, for the label on a hit. */
  sourceLicence: string;
}

/** What an import credits the data to. */
export interface DictionarySource {
  name: string;
  licence: string;
}

/** How far an import has got, reported after every batch. */
export interface ImportProgress {
  written: number;
  total: number;
}

/** One transaction's worth of writes. */
export interface DictionaryBatch {
  pair: string;
  entries: readonly DeviceDictionaryEntry[];
  /** Written in the SAME transaction as the entries when present. */
  meta: DictionaryMeta | null;
}

/**
 * The five operations the device dictionary needs from its storage.
 *
 * Deliberately not a key-value interface: the browser implementation can then
 * use a range delete for `deletePair`, which a generic one could not.
 */
export interface DictionaryStorage {
  /** Write the entries, and the meta when given, in one atomic step. */
  putBatch(batch: DictionaryBatch): Promise<void>;
  /** One entry by pair and normalised key, or `null`. */
  getEntry(pair: string, key: string): Promise<DeviceDictionaryEntry | null>;
  /** One dictionary's meta, or `null` when it is not (fully) imported. */
  getMeta(pair: string): Promise<DictionaryMeta | null>;
  /** The meta of every imported dictionary, in no particular order. */
  listMeta(): Promise<DictionaryMeta[]>;
  /** Remove a dictionary's meta AND its entries. */
  deletePair(pair: string): Promise<void>;
}

/** What {@link importDictionary} needs. */
export interface ImportDictionaryOptions {
  /** The directed pair key, such as `en-de`. Must name two served, different languages. */
  pair: string;
  entries: readonly DeviceDictionaryEntry[];
  source: DictionarySource;
  /** Called after every batch, so a screen can draw a progress bar. */
  onProgress?: (progress: ImportProgress) => void;
}

/** What {@link lookupDeviceEntry} needs. */
export interface LookupDeviceEntryOptions {
  pair: string;
  /** The language the query is written in. */
  from: LanguageCode;
  /** The text as typed. It is normalised here. */
  query: string;
}

/** A device dictionary's answer, with what the label needs. */
export interface DeviceDictionaryHit {
  entry: DeviceDictionaryEntry;
  meta: DictionaryMeta;
}

/**
 * Import a dictionary: clear the pair, write the entries in batches, then the meta.
 *
 * ORDER IS THE WHOLE POINT. The pair is cleared first so a second import never
 * leaves words of the first behind. The entries go in batches of
 * {@link IMPORT_BATCH_SIZE}, one transaction each, so one transaction never holds
 * a quarter of a million records and a failure loses at most the batch in flight.
 * The meta goes last, in its own transaction, for the reason in the file header.
 *
 * @param storage Where to write.
 * @param options The pair, its entries and what credits them.
 * @returns The meta that was written, which is now what the dictionary IS.
 * @throws Error If the pair is not a served direction, or there is nothing to
 *   import. An empty dictionary would be listed and answer nothing.
 */
export async function importDictionary(storage: DictionaryStorage, options: ImportDictionaryOptions): Promise<DictionaryMeta> {
  const { pair, entries, source, onProgress } = options;
  const direction = parseDeviceDictionaryPairKey(pair);
  if (direction === null) {
    throw new Error(`"${pair}" is not a pair of two different served languages`);
  }
  if (entries.length === 0) {
    throw new Error('The dictionary file held no usable entries');
  }
  await storage.deletePair(pair);
  for (let start = 0; start < entries.length; start += IMPORT_BATCH_SIZE) {
    const batch = entries.slice(start, start + IMPORT_BATCH_SIZE);
    await storage.putBatch({ pair, entries: batch, meta: null });
    onProgress?.({ written: start + batch.length, total: entries.length });
  }
  const meta: DictionaryMeta = {
    pair,
    from: direction.from,
    to: direction.to,
    entryCount: entries.length,
    importedAt: Date.now(),
    sourceName: source.name,
    sourceLicence: source.licence,
  };
  await storage.putBatch({ pair, entries: [], meta });
  return meta;
}

/**
 * Look a typed word up in one imported dictionary.
 *
 * A PHRASE NEVER HITS. Only single words use the device dictionary (the
 * milestone's non-goal), so a query of two or more words answers `null` without
 * touching the storage. So does a query with no letters in it.
 *
 * THE META IS CHECKED FIRST. It is one small read, and it is what stops the
 * orphaned entries of an interrupted import from answering as if the dictionary
 * had been imported. It is also the label the screen needs, so it is returned
 * rather than re-read.
 *
 * @param storage Where to read.
 * @param options The pair, the language of the query and the query.
 * @returns The entry and its dictionary's meta, or `null`.
 */
export async function lookupDeviceEntry(storage: DictionaryStorage, options: LookupDeviceEntryOptions): Promise<DeviceDictionaryHit | null> {
  const query = normalizeQuery(options.query, options.from);
  if (query.isPhrase || query.normalized === '') return null;
  const meta = await storage.getMeta(options.pair);
  if (meta === null) return null;
  const entry = await storage.getEntry(options.pair, query.normalized);
  return entry === null ? null : { entry, meta };
}

/**
 * Every dictionary this device holds, ordered by pair key.
 *
 * @param storage Where to read.
 */
export async function listImportedDictionaries(storage: DictionaryStorage): Promise<DictionaryMeta[]> {
  const metas = await storage.listMeta();
  return metas.toSorted((left, right) => left.pair.localeCompare(right.pair));
}

/**
 * Remove a dictionary from the device.
 *
 * @param storage Where to delete.
 * @param pair The directed pair key.
 */
export async function removeDictionary(storage: DictionaryStorage, pair: string): Promise<void> {
  await storage.deletePair(pair);
}

////////////////////////////////
// The IndexedDB shell
////////////////////////////////

/** What comes back out of IndexedDB is parsed, not trusted: another build may have written it. */
const entrySchema = z.object({
  key: z.string(),
  written: z.string(),
  translations: z.array(z.string()),
  score: z.number(),
}) satisfies z.ZodType<DeviceDictionaryEntry>;

/** The meta record as stored. */
const metaSchema = z.object({
  pair: z.string(),
  from: z.enum(PAIR_LANGUAGES),
  to: z.enum(PAIR_LANGUAGES),
  entryCount: z.number().int().nonnegative(),
  importedAt: z.number(),
  sourceName: z.string(),
  sourceLicence: z.string(),
}) satisfies z.ZodType<DictionaryMeta>;

/**
 * The failure of a request or a transaction, as an Error.
 *
 * @param cause The DOMException the browser gave, when it gave one.
 * @param fallback What to say when it gave none.
 */
function toError(cause: DOMException | null, fallback: string): Error {
  return cause ?? new Error(fallback);
}

/**
 * Open the database, creating its two object stores on first use.
 *
 * @param factory The IndexedDB factory, `indexedDB` in a browser.
 */
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore(META_STORE, { keyPath: 'pair' });
      request.result.createObjectStore(ENTRIES_STORE, { keyPath: ['pair', 'key'] });
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(toError(request.error, 'The device dictionary could not be opened')));
  });
}

/**
 * Resolve when a transaction has committed, reject when it aborts or fails.
 *
 * It must be attached BEFORE the first `await`, or a transaction that finishes
 * in the gap would be missed.
 *
 * @param transaction The transaction to wait for.
 */
function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () => reject(toError(transaction.error, 'The device dictionary could not be written')));
    transaction.addEventListener('abort', () => reject(toError(transaction.error, 'The device dictionary write was aborted')));
  });
}

/**
 * Run a group of writes inside a transaction and wait for it to commit.
 *
 * The completion promise is attached before the writes run, and a write that
 * throws on the spot (a record IndexedDB cannot store) aborts the transaction
 * and waits for the abort to settle, so no rejection is left without a handler.
 *
 * @param transaction A readwrite transaction.
 * @param writes Queues the writes on the transaction's object stores.
 */
async function commitWrites(transaction: IDBTransaction, writes: () => void): Promise<void> {
  const finished = waitForTransaction(transaction);
  try {
    writes();
  } catch (cause) {
    transaction.abort();
    await finished.catch(() => undefined);
    throw cause;
  }
  await finished;
}

/**
 * Read one record, parsed.
 *
 * @param request A `get` request.
 * @param schema What a valid record looks like.
 * @returns The record, or `null` when there is none or it does not parse.
 */
function readOne<T>(request: IDBRequest, schema: z.ZodType<T>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => {
      const parsed = schema.safeParse(request.result);
      resolve(parsed.success ? parsed.data : null);
    });
    request.addEventListener('error', () => reject(toError(request.error, 'The device dictionary could not be read')));
  });
}

/**
 * Read every record, parsed, dropping the ones that do not parse.
 *
 * @param request A `getAll` request.
 * @param schema What a valid record looks like.
 */
function readAll<T>(request: IDBRequest, schema: z.ZodType<T>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => {
      const rows = z.array(z.unknown()).safeParse(request.result);
      const parsed = rows.success ? rows.data.map((row) => schema.safeParse(row)) : [];
      resolve(parsed.flatMap((result) => (result.success ? [result.data] : [])));
    });
    request.addEventListener('error', () => reject(toError(request.error, 'The device dictionary could not be read')));
  });
}

/**
 * The browser's storage for the device dictionary.
 *
 * THIN ON PURPOSE. Every method opens (once) and runs one transaction. There is
 * no logic in here that a unit test would have wanted to cover: ordering,
 * batching and what counts as imported all live in the functions above.
 *
 * @param factory The IndexedDB factory. Defaults to the browser's own, and is
 *   read when this is CALLED, so importing this module on the server is safe.
 */
export function createIndexedDbStorage(factory: IDBFactory = indexedDB): DictionaryStorage {
  let opened: Promise<IDBDatabase> | undefined;
  const database = (): Promise<IDBDatabase> => {
    opened ??= openDatabase(factory).catch((cause: Error) => {
      opened = undefined;
      throw cause;
    });
    return opened;
  };
  return {
    async putBatch(batch) {
      const transaction = (await database()).transaction([ENTRIES_STORE, META_STORE], 'readwrite');
      await commitWrites(transaction, () => {
        const entries = transaction.objectStore(ENTRIES_STORE);
        for (const entry of batch.entries) entries.put({ pair: batch.pair, ...entry });
        if (batch.meta !== null) transaction.objectStore(META_STORE).put(batch.meta);
      });
    },
    async getEntry(pair, key) {
      const transaction = (await database()).transaction(ENTRIES_STORE, 'readonly');
      return readOne(transaction.objectStore(ENTRIES_STORE).get([pair, key]), entrySchema);
    },
    async getMeta(pair) {
      const transaction = (await database()).transaction(META_STORE, 'readonly');
      return readOne(transaction.objectStore(META_STORE).get(pair), metaSchema);
    },
    async listMeta() {
      const transaction = (await database()).transaction(META_STORE, 'readonly');
      return readAll(transaction.objectStore(META_STORE).getAll(), metaSchema);
    },
    async deletePair(pair) {
      const transaction = (await database()).transaction([ENTRIES_STORE, META_STORE], 'readwrite');
      await commitWrites(transaction, () => {
        transaction.objectStore(META_STORE).delete(pair);
        // An array key sorts after every string, so `[pair, []]` is above every
        // `[pair, <any key>]`, and `[pair, '']` is at or below the lowest.
        transaction.objectStore(ENTRIES_STORE).delete(IDBKeyRange.bound([pair, ''], [pair, []]));
      });
    },
  };
}
