/**
 * A device dictionary hit reaches NOTHING but the card that draws it (M208/03).
 *
 * TWO HALVES, BECAUSE ONE CANNOT PROVE THE OTHER
 *   1. The hook's logic is executed: the key, the stale guard, and what a
 *      lookup settles to for a hit, a miss, a phrase and every kind of failure.
 *      The stale guard is behaviour with a cost: the screen asks the AI by itself
 *      on a miss, so a miss left over from the previous word must never be read as
 *      this word's.
 *   2. The invariant is read as source. "No hit text goes anywhere" has no return
 *      value to assert on, so this is a tripwire like the one at the foot of
 *      `local-dictionary-store.test.ts`: it names the only files allowed to touch
 *      the device lookup, and it reads the history recorder, the favourite star and
 *      the card for anything that could carry a hit out.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { setErrorReporter, type ErrorContext } from '#app/lib/report-error';
import {
  WIKDICT_LICENCE,
  WIKDICT_SOURCE_NAME,
  importDictionary,
  type DeviceDictionaryEntry,
  type DictionaryMeta,
  type DictionaryStorage,
} from '#app/lib/local-dictionary/device-dictionary-store';
import {
  currentDeviceLookup,
  deviceLookupKey,
  settleDeviceLookup,
  type KeyedDeviceLookup,
} from '#app/lib/local-dictionary/use-device-dictionary-hit';

const ROOT = join(import.meta.dirname, '../..');

const HOUSE: DeviceDictionaryEntry = {
  key: 'house',
  written: 'house',
  translations: ['Haus', 'Gebäude'],
  score: 256.1,
};

/** A `Map`-backed storage, enough for a lookup. */
function memoryStorage(): DictionaryStorage {
  const entries = new Map<string, DeviceDictionaryEntry>();
  const metas = new Map<string, DictionaryMeta>();
  return {
    async putBatch(batch) {
      for (const entry of batch.entries) entries.set(`${batch.pair}\u0000${entry.key}`, entry);
      if (batch.meta !== null) metas.set(batch.pair, batch.meta);
    },
    async getEntry(pair, key) {
      return entries.get(`${pair}\u0000${key}`) ?? null;
    },
    async getMeta(pair) {
      return metas.get(pair) ?? null;
    },
    async listMeta() {
      return [...metas.values()];
    },
    async deletePair(pair) {
      metas.delete(pair);
    },
  };
}

/** A storage with `en-de` imported. */
async function importedStorage(): Promise<DictionaryStorage> {
  const storage = memoryStorage();
  await importDictionary(storage, {
    pair: 'en-de',
    entries: [HOUSE],
    source: { name: WIKDICT_SOURCE_NAME, licence: WIKDICT_LICENCE },
  });
  return storage;
}

afterEach(() => {
  setErrorReporter(null);
});

describe('the lookup key and the stale guard', () => {
  it('names the direction and the text, so two searches cannot share a key', () => {
    const keys = [
      deviceLookupKey({ from: 'en', to: 'de', q: 'house' }),
      deviceLookupKey({ from: 'de', to: 'en', q: 'house' }),
      deviceLookupKey({ from: 'en', to: 'de', q: 'home' }),
    ];
    assert.equal(new Set(keys).size, 3);
  });

  it('is idle when switched off, whatever was settled before', () => {
    const settled: KeyedDeviceLookup = { key: 'k', result: { status: 'miss' } };
    assert.deepEqual(currentDeviceLookup({ enabled: false, key: 'k', settled }), { status: 'idle' });
  });

  it('is loading before anything has settled, which is also what the server renders', () => {
    assert.deepEqual(currentDeviceLookup({ enabled: true, key: 'k', settled: null }), { status: 'loading' });
  });

  it('NEVER shows the previous word`s result for a new word', () => {
    const settled: KeyedDeviceLookup = { key: 'old', result: { status: 'miss' } };
    assert.deepEqual(currentDeviceLookup({ enabled: true, key: 'new', settled }), { status: 'loading' });
    const hit: KeyedDeviceLookup = { key: 'old', result: { status: 'hit', entry: HOUSE, meta: placeholderMeta() } };
    assert.deepEqual(currentDeviceLookup({ enabled: true, key: 'new', settled: hit }), { status: 'loading' });
  });

  it('reports the settled result for the search it was read for', () => {
    const settled: KeyedDeviceLookup = { key: 'k', result: { status: 'miss' } };
    assert.deepEqual(currentDeviceLookup({ enabled: true, key: 'k', settled }), { status: 'miss' });
  });
});

/** A meta record for the cases that need one but do not read it. */
function placeholderMeta(): DictionaryMeta {
  return {
    pair: 'en-de',
    from: 'en',
    to: 'de',
    entryCount: 1,
    importedAt: 0,
    sourceName: WIKDICT_SOURCE_NAME,
    sourceLicence: WIKDICT_LICENCE,
  };
}

describe('what a lookup settles to', () => {
  it('a hit carries the entry and the label the card prints', async () => {
    const storage = await importedStorage();

    const result = await settleDeviceLookup(() => storage, { from: 'en', to: 'de', q: 'House' });

    assert.equal(result.status, 'hit');
    assert.ok(result.status === 'hit');
    assert.deepEqual(result.entry, HOUSE);
    assert.equal(result.meta.sourceName, 'WikDict');
    assert.equal(result.meta.sourceLicence, 'CC BY-SA 4.0');
  });

  it('a word that is not there is a miss', async () => {
    const storage = await importedStorage();
    assert.deepEqual(await settleDeviceLookup(() => storage, { from: 'en', to: 'de', q: 'housee' }), {
      status: 'miss',
    });
  });

  it('a direction that was never imported is a miss: the cookie can be stale', async () => {
    const storage = await importedStorage();
    assert.deepEqual(await settleDeviceLookup(() => storage, { from: 'de', to: 'en', q: 'house' }), { status: 'miss' });
  });

  it('a phrase is a miss', async () => {
    const storage = await importedStorage();
    assert.deepEqual(await settleDeviceLookup(() => storage, { from: 'en', to: 'de', q: 'the house' }), {
      status: 'miss',
    });
  });

  it('a storage that throws is a miss, reported without the word', async () => {
    const reports: ErrorContext[] = [];
    setErrorReporter((_cause, context) => {
      reports.push(context ?? {});
    });
    const broken: DictionaryStorage = {
      ...memoryStorage(),
      async getMeta() {
        throw new Error('the database is blocked');
      },
    };

    const result = await settleDeviceLookup(() => broken, { from: 'en', to: 'de', q: 'secretword' });

    assert.deepEqual(result, { status: 'miss' });
    assert.equal(reports.length, 1);
    assert.equal(JSON.stringify(reports).includes('secretword'), false, 'the report names the searched word');
  });

  it('a storage that cannot even be opened is a miss, and never a rejection', async () => {
    setErrorReporter(() => undefined);
    const result = await settleDeviceLookup(
      () => {
        throw new ReferenceError('indexedDB is not defined');
      },
      { from: 'en', to: 'de', q: 'house' },
    );
    assert.deepEqual(result, { status: 'miss' });
  });
});

/** Every `.ts` and `.tsx` file under a directory of the repo, as repo-relative paths. */
function sourceFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(directory, entry));
}

describe('a hit reaches nothing but the card', () => {
  /** Every name by which the device dictionary or its lookup can be reached. Prose about "the device" is not one. */
  const DEVICE_DICTIONARY_NAMES = /DeviceDictionary|deviceDictionary|deviceLookup|device-dict|local-dictionary/;

  /** The only files that may name the device dictionary: its engine, its two screens and the hit card. */
  const ALLOWED = new Set([
    'app/components/device-dictionary-hit.tsx',
    'app/components/personal/device-dictionary-card.tsx',
    'app/components/search-panes.tsx',
  ]);

  it('is imported by no file outside the engine, the settings card, the hit card and the search screen', () => {
    const files = sourceFiles('app').filter((file) => !file.startsWith('app/lib/local-dictionary/'));
    assert.ok(files.length > 100, 'the walk must find the app, or this case proves nothing');
    const importing = files.filter((file) =>
      /from '#app\/lib\/local-dictionary\//.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    assert.deepEqual(importing.toSorted(), [...ALLOWED].toSorted());
  });

  it('the hook is used by the search screen and by nothing else', () => {
    const users = sourceFiles('app').filter((file) => {
      if (file.startsWith('app/lib/local-dictionary/')) return false;
      return readFileSync(join(ROOT, file), 'utf8').includes('useDeviceDictionaryHit');
    });
    assert.deepEqual(users, ['app/components/search-panes.tsx']);
  });

  it('the history recorder is given no device value, in the route or anywhere', () => {
    const route = readFileSync(join(ROOT, 'app/routes/translate.tsx'), 'utf8');
    const element = /<RecordSearch[\s\S]*?\/>/.exec(route)?.[0] ?? '';
    assert.ok(element.length > 0, 'the route no longer renders <RecordSearch>');
    assert.doesNotMatch(element, DEVICE_DICTIONARY_NAMES);
    const recorder = readFileSync(join(ROOT, 'app/components/personal/record-search.tsx'), 'utf8');
    assert.doesNotMatch(recorder, DEVICE_DICTIONARY_NAMES);
  });

  it('the favourite star is given no device value, and the toggle itself knows of none', () => {
    const panes = readFileSync(join(ROOT, 'app/components/search-panes.tsx'), 'utf8');
    const element = /<FavoriteToggle[\s\S]*?\/>/.exec(panes)?.[0] ?? '';
    assert.ok(element.length > 0, 'the screen no longer renders <FavoriteToggle>');
    assert.doesNotMatch(element, DEVICE_DICTIONARY_NAMES);
    const toggle = readFileSync(join(ROOT, 'app/components/personal/favorite-toggle.tsx'), 'utf8');
    assert.doesNotMatch(toggle, DEVICE_DICTIONARY_NAMES);
  });

  it('the answer text the star and the history read is still the controller`s alone', () => {
    const panes = readFileSync(join(ROOT, 'app/components/search-panes.tsx'), 'utf8');
    assert.match(panes, /const resultText = translation\.text;/);
  });

  it('the hit card and the answer body send nothing: no request, no form, no navigation', () => {
    const card = readFileSync(join(ROOT, 'app/components/device-dictionary-hit.tsx'), 'utf8');
    assert.doesNotMatch(card, /\bfetch\b|useFetcher|useSubmit|<Form|navigate|sendBeacon|XMLHttpRequest|\.submit\(/);
  });

  it('asking the AI posts no body, so there is nothing for a hit to ride on', () => {
    const pane = readFileSync(join(ROOT, 'app/components/translation-pane.tsx'), 'utf8');
    assert.match(pane, /fetcher\.submit\(null, \{ method: 'post', action: retryUrl \}\)/);
  });
});
