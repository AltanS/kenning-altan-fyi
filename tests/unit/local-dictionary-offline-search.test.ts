/**
 * `planOfflineSearch`, the direction and the screen an offline search draws,
 * against an in-memory stand-in for the device dictionary storage.
 *
 * WHAT IS PINNED
 *   - THE PAIR FOLLOWS THE SERVER'S PRECEDENCE: the URL, then the pair the device
 *     last chose (its cookie), then the default. A stated source is the direction.
 *   - `detect` IS DECIDED BY THE DEVICE'S OWN DICTIONARIES: those into the target
 *     first, and the first one that holds the word wins. With no hit anywhere the
 *     first dictionary into the target is the direction, then the partner of the
 *     target, so a miss is reported against a direction that makes sense.
 *   - A PHRASE IS A PHRASE BY THE SAME CALL THE SERVER MAKES, `normalizeQuery`.
 *   - THE PLAN CARRIES NO DICTIONARY TEXT. Reading the store to pick a direction is
 *     allowed and returning what it read is not (ADR-0013), so the cases search for
 *     a word that IS in the dictionary and prove no translation rides out.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WIKDICT_LICENCE,
  WIKDICT_SOURCE_NAME,
  importDictionary,
  type DeviceDictionaryEntry,
  type DictionaryMeta,
  type DictionaryStorage,
} from '#app/lib/local-dictionary/device-dictionary-store';
import {
  NO_DICTIONARIES,
  orderDictionariesForTarget,
  planOfflineSearch,
  type OfflineSearchInput,
} from '#app/lib/local-dictionary/offline-search';

const SOURCE = { name: WIKDICT_SOURCE_NAME, licence: WIKDICT_LICENCE };

/** A distinctive translation, so a leak into the plan is easy to see. */
const SECRET_TRANSLATION = 'Hausgeheimnis';

const HOUSE: DeviceDictionaryEntry = { key: 'house', written: 'house', translations: [SECRET_TRANSLATION], score: 9 };
const HAUS: DeviceDictionaryEntry = { key: 'haus', written: 'Haus', translations: ['housesecret'], score: 9 };

/** A `Map`-backed storage, enough for lookups and listing. */
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

/** A device holding the named dictionaries, each with the entries given. */
async function deviceWith(dictionaries: Record<string, DeviceDictionaryEntry[]>): Promise<DictionaryStorage> {
  const storage = memoryStorage();
  for (const [pair, entries] of Object.entries(dictionaries)) {
    await importDictionary(storage, { pair, entries, source: SOURCE });
  }
  return storage;
}

/** The input with every field defaulted to "nothing said". */
function input(overrides: Partial<OfflineSearchInput> = {}): OfflineSearchInput {
  return { q: '', urlFrom: null, urlTo: null, cookieHeader: null, ...overrides };
}

describe('the pair and a stated direction', () => {
  it('takes the URL first', async () => {
    const storage = await deviceWith({ 'de-en': [HAUS] });
    const plan = await planOfflineSearch(storage, input({ q: 'haus', urlFrom: 'de', urlTo: 'en' }));
    assert.deepEqual(plan.direction, { from: 'de', to: 'en', detected: false });
    assert.deepEqual(plan.pair, { source: 'de', target: 'en' });
  });

  it('falls back to the pair this device last chose, read from its cookie', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE] });
    const plan = await planOfflineSearch(storage, input({ q: 'house', cookieHeader: 'theme=dark; translate-pair=en:de' }));
    assert.deepEqual(plan.direction, { from: 'en', to: 'de', detected: false });
  });

  it('lets the URL win over the cookie, per side', async () => {
    const storage = await deviceWith({});
    const plan = await planOfflineSearch(
      storage,
      input({ q: 'x', urlFrom: 'es', cookieHeader: 'translate-pair=en:de' }),
    );
    assert.deepEqual(plan.direction, { from: 'es', to: 'de', detected: false });
  });

  it('repairs a target that equals the stated source, the way the server does', async () => {
    const storage = await deviceWith({});
    const plan = await planOfflineSearch(storage, input({ q: 'x', urlFrom: 'de', urlTo: 'de' }));
    assert.deepEqual(plan.direction, { from: 'de', to: 'en', detected: false });
  });
});

describe('detect picks a direction from the dictionaries on the device', () => {
  it('prefers a dictionary into the target, and keeps the first that holds the word', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE], 'de-en': [HAUS] });
    const plan = await planOfflineSearch(storage, input({ q: 'house', urlFrom: 'detect', urlTo: 'de' }));
    assert.deepEqual(plan.direction, { from: 'en', to: 'de', detected: true });
    assert.deepEqual(plan.pair, { source: 'detect', target: 'de' });
  });

  it('moves to the other direction when the preferred one lacks the word, and reconciles the target', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE], 'de-en': [HAUS] });
    const plan = await planOfflineSearch(storage, input({ q: 'Haus', urlFrom: 'detect', urlTo: 'de' }));
    assert.deepEqual(plan.direction, { from: 'de', to: 'en', detected: true });
    // The bar shows the side the search used, as it does online.
    assert.deepEqual(plan.pair, { source: 'detect', target: 'en' });
  });

  it('reads the pair cookie for a detect source too', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE] });
    const plan = await planOfflineSearch(storage, input({ q: 'house', cookieHeader: 'translate-pair=detect:de' }));
    assert.equal(plan.direction.detected, true);
    assert.deepEqual([plan.direction.from, plan.direction.to], ['en', 'de']);
  });

  it('chooses the first dictionary into the target when no dictionary holds the word', async () => {
    const storage = await deviceWith({ 'de-en': [HAUS], 'en-de': [HOUSE] });
    const plan = await planOfflineSearch(storage, input({ q: 'nonexistent', urlFrom: 'detect', urlTo: 'de' }));
    assert.deepEqual(plan.direction, { from: 'en', to: 'de', detected: true });
  });

  it('falls back to the partner of the target when nothing translates into it', async () => {
    const storage = await deviceWith({ 'de-en': [HAUS] });
    const plan = await planOfflineSearch(storage, input({ q: 'nonexistent', urlFrom: 'detect', urlTo: 'tr' }));
    assert.deepEqual(plan.direction, { from: 'en', to: 'tr', detected: true });
  });

  it('falls back to the partner of an English target when the device holds nothing', async () => {
    const plan = await planOfflineSearch(NO_DICTIONARIES, input({ q: 'haus', urlFrom: 'detect', urlTo: 'en' }));
    assert.deepEqual(plan.direction, { from: 'de', to: 'en', detected: true });
    assert.deepEqual(plan.dictionaries, []);
  });

  it('does not reconcile the pair when nothing was searched', async () => {
    const storage = await deviceWith({ 'de-en': [HAUS] });
    const plan = await planOfflineSearch(storage, input({ q: '', urlFrom: 'detect', urlTo: 'de' }));
    assert.deepEqual(plan.pair, { source: 'detect', target: 'de' });
  });
});

describe('a phrase', () => {
  it('is a phrase by the same call the server makes', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE] });
    const plan = await planOfflineSearch(storage, input({ q: 'the house', urlFrom: 'en', urlTo: 'de' }));
    assert.equal(plan.isPhrase, true);
  });

  it('is not one for a single word, however it is punctuated', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE] });
    for (const q of ['house', 'House?', '"house"', '']) {
      const plan = await planOfflineSearch(storage, input({ q, urlFrom: 'en', urlTo: 'de' }));
      assert.equal(plan.isPhrase, false, q);
    }
  });

  it('is still decided under detect, where the direction has to be picked first', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE] });
    const plan = await planOfflineSearch(storage, input({ q: 'the house', urlFrom: 'detect', urlTo: 'de' }));
    assert.equal(plan.isPhrase, true);
  });
});

describe('the dictionaries the empty screen lists', () => {
  it('names each by pair, direction and size, in pair order', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE], 'de-en': [HAUS, { ...HAUS, key: 'baum' }] });
    const plan = await planOfflineSearch(storage, input());
    assert.deepEqual(plan.dictionaries, [
      { pair: 'de-en', from: 'de', to: 'en', entryCount: 2 },
      { pair: 'en-de', from: 'en', to: 'de', entryCount: 1 },
    ]);
  });

  it('lists nothing on a device with no dictionary, which the screen answers with the import hint', async () => {
    const plan = await planOfflineSearch(NO_DICTIONARIES, input());
    assert.deepEqual(plan.dictionaries, []);
  });
});

describe('the plan carries no dictionary text (ADR-0013)', () => {
  it('holds neither a translation nor a written form, though it read the entry to pick a direction', async () => {
    const storage = await deviceWith({ 'en-de': [HOUSE], 'de-en': [HAUS] });
    for (const q of ['house', 'Haus']) {
      const plan = await planOfflineSearch(storage, input({ q, urlFrom: 'detect', urlTo: 'de' }));
      const serialised = JSON.stringify(plan);
      assert.equal(serialised.includes(SECRET_TRANSLATION), false, 'a translation rode out in the plan');
      assert.equal(serialised.includes('housesecret'), false, 'a translation rode out in the plan');
      assert.deepEqual(Object.keys(plan).toSorted(), ['dictionaries', 'direction', 'isPhrase', 'pair']);
    }
  });
});

describe('orderDictionariesForTarget', () => {
  const meta = (pair: string, from: 'en' | 'de' | 'tr', to: 'en' | 'de' | 'tr'): DictionaryMeta => ({
    pair,
    from,
    to,
    entryCount: 1,
    importedAt: 0,
    sourceName: SOURCE.name,
    sourceLicence: SOURCE.licence,
  });

  it('puts the dictionaries into the target first and keeps pair order inside each group', () => {
    const ordered = orderDictionariesForTarget(
      [meta('tr-de', 'tr', 'de'), meta('en-tr', 'en', 'tr'), meta('en-de', 'en', 'de'), meta('de-en', 'de', 'en')],
      'de',
    ).map((entry) => entry.pair);
    assert.deepEqual(ordered, ['en-de', 'tr-de', 'de-en', 'en-tr']);
  });
});

describe('NO_DICTIONARIES', () => {
  it('answers like an empty device for every read', async () => {
    assert.equal(await NO_DICTIONARIES.getMeta('en-de'), null);
    assert.equal(await NO_DICTIONARIES.getEntry('en-de', 'house'), null);
    assert.deepEqual(await NO_DICTIONARIES.listMeta(), []);
  });
});
