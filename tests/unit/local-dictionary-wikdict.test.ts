/**
 * The WikDict importer: file names, rows into entries, and a real file's bytes.
 *
 * WHAT IS PINNED, AND WHY EACH ONE IS A REAL RISK
 *
 *   - THE KEY IS `normalizeForLanguage`, NOT A COPY OF IT. The index is looked
 *     up with a key the search path folds, so the importer and the lookup must
 *     share one folding. The cases compare keys with the function itself and pin
 *     one literal (`Straße` to `strasse`, the example the function documents), so
 *     a swapped-in second implementation shows up.
 *   - ROWS THAT SHARE A KEY MERGE, HIGHEST SCORE FIRST. `Haus` and `haus` are two
 *     upstream rows and must be one answer, led by the more common reading.
 *     Without the merge, which row wins would depend on the order of a table.
 *   - AN UNUSABLE ROW IS SKIPPED, A MALFORMED TABLE IS NOT. A NULL translation
 *     list is how WikDict leaves a hole, and skipping it is correct. A row with
 *     three columns means the table is not the one this reads, and importing the
 *     rest would be guessing.
 *   - THE FILE NAME IS THE ONLY LANGUAGE METADATA. The file has none, so the
 *     parser is the whole defence against importing `de-en` as `en-de`, and it
 *     must refuse a language the app does not serve.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeForLanguage } from '#app/lib/dictionary/normalize';
import { buildWikdictIndex, indexWikdictRows, parseWikdictFileName } from '#app/lib/local-dictionary/wikdict';
import { SqliteFormatError, type SqliteValue } from '#app/lib/local-dictionary/sqlite-table-reader';

/** The fixture's first page ends here, and the schema rows live in it. */
const FIRST_PAGE_END = 512;

/** A fresh copy of the committed fixture. */
function readFixture(): Buffer {
  return Buffer.from(readFileSync(new URL('../fixtures/local-dictionary/mini-wikdict.sqlite3', import.meta.url)));
}

/** One `simple_translation` row, with the columns in table order. */
function row(written: SqliteValue, list: SqliteValue, score: SqliteValue = 1): SqliteValue[] {
  return [written, list, score, 1];
}

describe('parseWikdictFileName', () => {
  it('reads the direction off a WikDict file name', () => {
    assert.deepEqual(parseWikdictFileName('en-de.sqlite3'), { from: 'en', to: 'de' });
    assert.deepEqual(parseWikdictFileName('tr-es.sqlite3'), { from: 'tr', to: 'es' });
    assert.deepEqual(parseWikdictFileName('de-en.sqlite'), { from: 'de', to: 'en' });
  });

  it('refuses a language the app does not serve', () => {
    assert.equal(parseWikdictFileName('en-fr.sqlite3'), null);
    assert.equal(parseWikdictFileName('fr-de.sqlite3'), null);
    assert.equal(parseWikdictFileName('xx-yy.sqlite3'), null);
  });

  it('refuses a direction from a language to itself', () => {
    assert.equal(parseWikdictFileName('en-en.sqlite3'), null);
  });

  it('refuses anything that is not exactly a WikDict file name', () => {
    const names = [
      'EN-DE.sqlite3',
      'en-de',
      'en-de.sqlite33',
      'en-de.sqlite3.gz',
      'en-de.db',
      'en-deu.sqlite3',
      'e-de.sqlite3',
      '/tmp/en-de.sqlite3',
      ' en-de.sqlite3',
      'en_de.sqlite3',
      '',
    ];
    for (const name of names) {
      assert.equal(parseWikdictFileName(name), null, `"${name}" must not parse`);
    }
  });
});

describe('indexWikdictRows', () => {
  it('keys an entry with the same fold the search path uses', () => {
    const [entry] = indexWikdictRows([row('Straße', 'street')], { from: 'de' });

    assert.equal(entry?.key, 'strasse');
    assert.equal(entry?.key, normalizeForLanguage('Straße', 'de'));
    assert.equal(entry?.written, 'Straße');
  });

  it('folds by the language of the written form', () => {
    const [entry] = indexWikdictRows([row('IŞIK', 'light')], { from: 'tr' });

    assert.equal(entry?.key, normalizeForLanguage('IŞIK', 'tr'));
  });

  it('splits a translation list on the three-character separator and keeps inner commas', () => {
    const [entry] = indexWikdictRows([row('house', 'Haus | Kammer | Mutter, Vater, Kind', 256.1)], { from: 'en' });

    assert.deepEqual(entry, { key: 'house', written: 'house', translations: ['Haus', 'Kammer', 'Mutter, Vater, Kind'], score: 256.1 });
  });

  it('trims every word and drops empty words and repeats', () => {
    const [entry] = indexWikdictRows([row('word', 'x | y |  | x | z |  w  ')], { from: 'en' });

    assert.deepEqual(entry?.translations, ['x', 'y', 'z', 'w']);
  });

  it('merges rows that share a key, the higher score first', () => {
    const entries = indexWikdictRows(
      [row('Haus', 'Gebäude | Haus', 10), row('haus', 'Heim | Haus', 30), row('HAUS', 'Bude', 20)],
      { from: 'de' },
    );

    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { key: 'haus', written: 'haus', translations: ['Heim', 'Haus', 'Bude', 'Gebäude'], score: 30 });
  });

  it('keeps the order of the file between rows of equal score', () => {
    const [entry] = indexWikdictRows([row('Haus', 'first', 5), row('haus', 'second', 5)], { from: 'de' });

    assert.deepEqual(entry?.translations, ['first', 'second']);
    assert.equal(entry?.written, 'Haus');
  });

  it('lists distinct keys in the order the file first met them', () => {
    const entries = indexWikdictRows([row('b', 'B'), row('a', 'A'), row('B', 'again')], { from: 'en' });

    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['b', 'a'],
    );
  });

  it('skips a row with no usable word or no usable translation', () => {
    const entries = indexWikdictRows(
      [
        row(null, 'x'),
        row('', 'x'),
        row('   ', 'x'),
        row(42, 'x'),
        row('noList', null),
        row('emptyList', ''),
        row('onlySeparators', ' |  | '),
        row('keeper', 'ok'),
      ],
      { from: 'en' },
    );

    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['keeper'],
    );
  });

  it('scores a row 0 when its score is not a number', () => {
    const [entry] = indexWikdictRows([row('word', 'x', null)], { from: 'en' });

    assert.equal(entry?.score, 0);
  });

  it('refuses a table whose rows have fewer than four columns', () => {
    assert.throws(() => indexWikdictRows([['house', 'Haus', 1]], { from: 'en' }), SqliteFormatError);
  });
});

describe('buildWikdictIndex on a real SQLite file', () => {
  it('turns the fixture into one entry per usable row', () => {
    const entries = buildWikdictIndex(readFixture(), { from: 'de' });
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));

    // 1500 plain rows, Überlang and Int. `leer` has a NULL list and is skipped.
    assert.equal(entries.length, 1502);
    assert.equal(byKey.has('leer'), false);
    assert.deepEqual(byKey.get('wort0001'), {
      key: 'wort0001',
      written: 'wort0001',
      translations: ['eins1', 'zwei1', 'Hühnchen'],
      score: 1.5,
    });
    assert.deepEqual(byKey.get('int'), { key: 'int', written: 'Int', translations: ['sieben'], score: 7 });
  });

  it('carries the overflow row whole, all twelve hundred distinct words', () => {
    const entries = buildWikdictIndex(readFixture(), { from: 'de' });
    const long = entries.find((entry) => entry.written === 'Überlang');

    assert.equal(long?.key, normalizeForLanguage('Überlang', 'de'));
    assert.equal(long?.translations.length, 1200);
    assert.equal(long?.translations[0], 'lang1');
    assert.equal(long?.translations[1199], 'lang1200');
  });

  it('refuses a file with no simple_translation table', () => {
    const bytes = readFixture();
    let at = bytes.indexOf('simple_translation');
    while (at !== -1 && at < FIRST_PAGE_END) {
      bytes[at] = 'x'.charCodeAt(0);
      at = bytes.indexOf('simple_translation', at + 1);
    }

    assert.throws(() => buildWikdictIndex(bytes, { from: 'de' }), SqliteFormatError);
  });

  it('refuses bytes that are not SQLite', () => {
    assert.throws(() => buildWikdictIndex(new TextEncoder().encode('not a database'.repeat(40)), { from: 'de' }), SqliteFormatError);
  });
});
