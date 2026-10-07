/**
 * The device dictionary's store logic, against an in-memory stand-in for IndexedDB.
 *
 * WHY A STAND-IN AND NOT A FAKE IDB. Node has no IndexedDB, and this repository
 * has no `fake-indexeddb` and may not gain one. The store is therefore written
 * as logic over the five-method `DictionaryStorage` interface, and these cases
 * drive that logic with a `Map`. What they cannot run is the thin browser shell
 * (`createIndexedDbStorage`); the shell holds no logic worth a test, and its
 * header says so.
 *
 * WHAT IS PINNED
 *   - THE META IS WRITTEN LAST. An import that dies between batches must not be
 *     listed, so the cases interrupt one and ask the list.
 *   - A SECOND IMPORT REPLACES THE FIRST. A word that left the file must leave
 *     the index, or a reader keeps answers from a dictionary they replaced.
 *   - A LOOKUP READS THE QUERY THE WAY SEARCH DOES. Case, accents and a pasted
 *     question mark must not change a hit, and a phrase must never hit.
 *   - AN ORPHANED ENTRY ANSWERS NOTHING. An interrupted import leaves entries
 *     with no meta, and those must be invisible.
 *
 * THE LAST DESCRIBE IS THE INVARIANT OF THE WHOLE MILESTONE, in executable form:
 * no imported byte reaches the server, the sync blob, the search history or a
 * prompt. It cannot be proved by running anything here, so it reads the source
 * and refuses the imports and calls that would carry bytes out, and refuses any
 * server-side module that names the directory. It is a tripwire, not a proof.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  IMPORT_BATCH_SIZE,
  WIKDICT_LICENCE,
  WIKDICT_SOURCE_NAME,
  importDictionary,
  listImportedDictionaries,
  lookupDeviceEntry,
  removeDictionary,
  type DeviceDictionaryEntry,
  type DictionaryBatch,
  type DictionaryMeta,
  type DictionaryStorage,
  type ImportProgress,
} from '#app/lib/local-dictionary/device-dictionary-store';

/** The repository root, resolved from this file so the working directory is irrelevant. */
const ROOT = join(import.meta.dirname, '../..');

/** The credit every import in these cases passes. */
const SOURCE = { name: WIKDICT_SOURCE_NAME, licence: WIKDICT_LICENCE };

/** The map key of one stored entry. A NUL cannot occur in a pair key or a word. */
function slot(pair: string, key: string): string {
  return `${pair}\u0000${key}`;
}

/** Every module specifier a file imports, whatever the import's shape. */
function specifiersOf(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1] ?? '');
}

/** The storage stand-in, with the calls it received kept for the ordering cases. */
interface MemoryStorage extends DictionaryStorage {
  readonly batches: DictionaryBatch[];
  readonly deletedPairs: string[];
  /** Entries held right now, as `pair` and `key` pairs. */
  countEntries(pair: string): number;
  /** Plant an entry with no meta, the way an interrupted import leaves it. */
  plantOrphan(pair: string, entry: DeviceDictionaryEntry): void;
}

/**
 * An in-memory `DictionaryStorage`.
 *
 * @param failOnBatch When set, the putBatch call with this zero-based index
 *   throws instead of writing, which is how a closed tab looks to the importer.
 */
function createMemoryStorage(failOnBatch: number | null = null): MemoryStorage {
  const entries = new Map<string, DeviceDictionaryEntry>();
  const metas = new Map<string, DictionaryMeta>();
  const batches: DictionaryBatch[] = [];
  const deletedPairs: string[] = [];
  return {
    batches,
    deletedPairs,
    async putBatch(batch) {
      const index = batches.length;
      batches.push(batch);
      if (index === failOnBatch) throw new Error('the tab was closed');
      for (const entry of batch.entries) entries.set(slot(batch.pair, entry.key), entry);
      if (batch.meta !== null) metas.set(batch.pair, batch.meta);
    },
    async getEntry(pair, key) {
      return entries.get(slot(pair, key)) ?? null;
    },
    async getMeta(pair) {
      return metas.get(pair) ?? null;
    },
    async listMeta() {
      return [...metas.values()];
    },
    async deletePair(pair) {
      deletedPairs.push(pair);
      metas.delete(pair);
      for (const stored of entries.keys()) {
        if (stored.startsWith(`${pair}\u0000`)) entries.delete(stored);
      }
    },
    countEntries(pair) {
      return [...entries.keys()].filter((stored) => stored.startsWith(`${pair}\u0000`)).length;
    },
    plantOrphan(pair, entry) {
      entries.set(slot(pair, entry.key), entry);
    },
  };
}

/** Entries `w0`, `w1`, ... for the batching cases. */
function makeEntries(count: number): DeviceDictionaryEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `w${index}`,
    written: `w${index}`,
    translations: [`t${index}`],
    score: count - index,
  }));
}

/** The one entry the lookup cases search for. */
const HOUSE: DeviceDictionaryEntry = { key: 'house', written: 'house', translations: ['Haus', 'Gebäude'], score: 256.1 };

describe('importDictionary', () => {
  it('writes the entries in batches of five thousand, then the meta alone, last', async () => {
    const storage = createMemoryStorage();

    const meta = await importDictionary(storage, { pair: 'en-de', entries: makeEntries(12_001), source: SOURCE });

    assert.equal(IMPORT_BATCH_SIZE, 5000);
    assert.deepEqual(
      storage.batches.map((batch) => batch.entries.length),
      [5000, 5000, 2001, 0],
    );
    assert.deepEqual(
      storage.batches.map((batch) => batch.meta !== null),
      [false, false, false, true],
    );
    assert.equal(storage.countEntries('en-de'), 12_001);
    assert.equal(meta.entryCount, 12_001);
  });

  it('records the pair, its two languages and where the data came from', async () => {
    const storage = createMemoryStorage();
    const before = Date.now();

    const meta = await importDictionary(storage, { pair: 'de-tr', entries: makeEntries(3), source: SOURCE });

    assert.equal(meta.pair, 'de-tr');
    assert.equal(meta.from, 'de');
    assert.equal(meta.to, 'tr');
    assert.equal(meta.sourceName, 'WikDict');
    assert.equal(meta.sourceLicence, 'CC BY-SA 4.0');
    assert.ok(meta.importedAt >= before && meta.importedAt <= Date.now());
    assert.deepEqual(await storage.getMeta('de-tr'), meta);
  });

  it('reports progress after every batch, ending at the total', async () => {
    const storage = createMemoryStorage();
    const seen: ImportProgress[] = [];

    await importDictionary(storage, { pair: 'en-de', entries: makeEntries(12_001), source: SOURCE, onProgress: (progress) => seen.push(progress) });

    assert.deepEqual(seen, [
      { written: 5000, total: 12_001 },
      { written: 10_000, total: 12_001 },
      { written: 12_001, total: 12_001 },
    ]);
  });

  it('does not list a dictionary whose import was interrupted', async () => {
    const storage = createMemoryStorage(1);

    await assert.rejects(() => importDictionary(storage, { pair: 'en-de', entries: makeEntries(12_001), source: SOURCE }), /tab was closed/);

    assert.deepEqual(await listImportedDictionaries(storage), []);
    assert.equal(await storage.getMeta('en-de'), null);
    assert.equal(storage.countEntries('en-de'), 5000, 'the first batch is on the device, unlisted');
  });

  it('clears an earlier import of the same pair before writing', async () => {
    const storage = createMemoryStorage();
    await importDictionary(storage, { pair: 'en-de', entries: [HOUSE], source: SOURCE });

    await importDictionary(storage, { pair: 'en-de', entries: makeEntries(2), source: SOURCE });

    assert.equal(await storage.getEntry('en-de', 'house'), null);
    assert.equal(storage.countEntries('en-de'), 2);
    assert.deepEqual(storage.deletedPairs, ['en-de', 'en-de']);
  });

  it('leaves the other direction alone', async () => {
    const storage = createMemoryStorage();
    await importDictionary(storage, { pair: 'de-en', entries: makeEntries(4), source: SOURCE });

    await importDictionary(storage, { pair: 'en-de', entries: makeEntries(2), source: SOURCE });

    assert.equal(storage.countEntries('de-en'), 4);
  });

  it('refuses a pair that is not two different served languages', async () => {
    const storage = createMemoryStorage();

    for (const pair of ['en-en', 'en-fr', 'junk', '']) {
      await assert.rejects(() => importDictionary(storage, { pair, entries: makeEntries(1), source: SOURCE }), /not a pair/, pair);
    }
    assert.equal(storage.batches.length, 0);
  });

  it('refuses to import nothing, rather than list an empty dictionary', async () => {
    const storage = createMemoryStorage();

    await assert.rejects(() => importDictionary(storage, { pair: 'en-de', entries: [], source: SOURCE }), /no usable entries/);

    assert.deepEqual(await listImportedDictionaries(storage), []);
    assert.equal(storage.deletedPairs.length, 0, 'a refused import must not wipe the dictionary already there');
  });
});

describe('lookupDeviceEntry', () => {
  async function importedStorage(): Promise<MemoryStorage> {
    const storage = createMemoryStorage();
    await importDictionary(storage, { pair: 'en-de', entries: [HOUSE], source: SOURCE });
    return storage;
  }

  it('finds a word and returns the label that goes with it', async () => {
    const storage = await importedStorage();

    const hit = await lookupDeviceEntry(storage, { pair: 'en-de', from: 'en', query: 'house' });

    assert.deepEqual(hit?.entry, HOUSE);
    assert.equal(hit?.meta.sourceName, 'WikDict');
    assert.equal(hit?.meta.sourceLicence, 'CC BY-SA 4.0');
  });

  it('reads the query the way search does: case, surrounding punctuation, whitespace', async () => {
    const storage = await importedStorage();

    for (const query of ['House', 'HOUSE', '  house  ', 'house?', '"house"', 'house.']) {
      const hit = await lookupDeviceEntry(storage, { pair: 'en-de', from: 'en', query });
      assert.equal(hit?.entry.key, 'house', `"${query}" must find house`);
    }
  });

  it('finds an entry whose key was folded at import, from an accented query', async () => {
    const storage = createMemoryStorage();
    await importDictionary(storage, {
      pair: 'de-en',
      entries: [{ key: 'strasse', written: 'Straße', translations: ['street'], score: 1 }],
      source: SOURCE,
    });

    const hit = await lookupDeviceEntry(storage, { pair: 'de-en', from: 'de', query: 'Straße' });

    assert.equal(hit?.entry.written, 'Straße');
  });

  it('answers null for a word that is not there', async () => {
    const storage = await importedStorage();

    assert.equal(await lookupDeviceEntry(storage, { pair: 'en-de', from: 'en', query: 'housee' }), null);
  });

  it('answers null for a phrase, without reading the storage', async () => {
    const storage = await importedStorage();
    let reads = 0;
    const counting: DictionaryStorage = {
      ...storage,
      async getMeta(pair) {
        reads += 1;
        return storage.getMeta(pair);
      },
    };

    assert.equal(await lookupDeviceEntry(counting, { pair: 'en-de', from: 'en', query: 'the house' }), null);
    assert.equal(reads, 0);
  });

  it('answers null for a query with no letters in it', async () => {
    const storage = await importedStorage();

    for (const query of ['', '   ', '?!', '"."']) {
      assert.equal(await lookupDeviceEntry(storage, { pair: 'en-de', from: 'en', query }), null, `"${query}"`);
    }
  });

  it('answers null for a pair that was never imported', async () => {
    const storage = await importedStorage();

    assert.equal(await lookupDeviceEntry(storage, { pair: 'de-en', from: 'de', query: 'house' }), null);
  });

  it('does not answer from the orphaned entries of an interrupted import', async () => {
    const storage = createMemoryStorage();
    storage.plantOrphan('en-de', HOUSE);

    assert.equal(await lookupDeviceEntry(storage, { pair: 'en-de', from: 'en', query: 'house' }), null);
  });
});

describe('listImportedDictionaries and removeDictionary', () => {
  it('lists every imported dictionary ordered by pair', async () => {
    const storage = createMemoryStorage();
    await importDictionary(storage, { pair: 'tr-en', entries: makeEntries(1), source: SOURCE });
    await importDictionary(storage, { pair: 'en-de', entries: makeEntries(1), source: SOURCE });
    await importDictionary(storage, { pair: 'de-en', entries: makeEntries(1), source: SOURCE });

    const list = await listImportedDictionaries(storage);

    assert.deepEqual(
      list.map((meta) => meta.pair),
      ['de-en', 'en-de', 'tr-en'],
    );
  });

  it('lists nothing on an empty device', async () => {
    assert.deepEqual(await listImportedDictionaries(createMemoryStorage()), []);
  });

  it('removes the meta and every entry of one pair, and only that pair', async () => {
    const storage = createMemoryStorage();
    await importDictionary(storage, { pair: 'en-de', entries: [HOUSE], source: SOURCE });
    await importDictionary(storage, { pair: 'de-en', entries: makeEntries(3), source: SOURCE });

    await removeDictionary(storage, 'en-de');

    assert.equal(await lookupDeviceEntry(storage, { pair: 'en-de', from: 'en', query: 'house' }), null);
    assert.equal(storage.countEntries('en-de'), 0);
    assert.deepEqual(
      (await listImportedDictionaries(storage)).map((meta) => meta.pair),
      ['de-en'],
    );
    assert.equal(storage.countEntries('de-en'), 3);
  });
});

describe('the device dictionary never leaves the device', () => {
  const ENGINE_DIR = join(ROOT, 'app/lib/local-dictionary');

  const engineFiles = readdirSync(ENGINE_DIR).filter((name) => name.endsWith('.ts'));

  it('finds the engine files it is about to inspect', () => {
    assert.deepEqual(engineFiles.toSorted(), [
      'card-state.ts',
      'device-dictionary-store.ts',
      'sqlite-table-reader.ts',
      'use-device-dictionary-hit.ts',
      'wikdict-downloads.ts',
      'wikdict.ts',
    ]);
  });

  for (const name of engineFiles) {
    const source = readFileSync(join(ENGINE_DIR, name), 'utf8');

    it(`${name} imports nothing that reaches a server, the sync blob or a model`, () => {
      const forbidden = /tinybase|local-store|\/sync|drizzle|\.server|react-router|\/llm|\/prompts|\/workflows|\/models|\/services/u;
      for (const specifier of specifiersOf(source)) {
        assert.equal(forbidden.test(specifier), false, `${name} imports "${specifier}"`);
      }
    });

    it(`${name} opens no network connection and writes no cookie`, () => {
      const outbound = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|document\.cookie|localStorage|sessionStorage/u;
      assert.equal(outbound.test(source), false, `${name} reaches outward`);
    });
  }

  it('is imported by no server-side module', () => {
    const serverRoots = ['app/models', 'app/workflows', 'app/services', 'cli', 'drizzle'];
    const listed = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
        .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
        .map((entry) => join(dir, entry));
    const serverNamed = listed('app').filter((file) => file.includes('.server.'));
    const files = [...serverRoots.flatMap(listed), ...serverNamed, 'server.ts'];

    assert.ok(files.length > 20, 'the walk must find the server modules, or this case proves nothing');
    for (const file of files) {
      assert.equal(readFileSync(join(ROOT, file), 'utf8').includes('local-dictionary'), false, `${file} names the device dictionary`);
    }
  });
});
