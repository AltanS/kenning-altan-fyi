/**
 * The SQLite table reader, held against a file a real `sqlite3` wrote.
 *
 * THE ORACLE. `tests/fixtures/local-dictionary/mini-wikdict.sqlite3` was made
 * with the `sqlite3` command line tool, at page size 512 and UTF-8, and every
 * fact asserted below was read back out of it with `sqlite3` itself. This test
 * therefore compares the reader with SQLite, not with the reader's author's idea
 * of SQLite. The reader's two risky parts, the b-tree walk and the overflow
 * arithmetic, are both forced into play by the fixture:
 *
 *   - 1503 rows at 512-byte pages cannot fit one leaf, so `simple_translation`
 *     has interior pages (its root, page 3, is one), and reading all 1503 rows
 *     in order proves the walk visits every leaf, left to right.
 *   - One row, `Überlang`, carries a 12090-character `trans_list`, which is far
 *     beyond what a 512-byte page holds, so its record spills into a chain of
 *     overflow pages and has to be reassembled byte for byte.
 *
 * THE FILE ALSO HOLDS A DECOY. Table `translation` (root page 2) has one row of
 * different shape. A reader that scanned the wrong root page, or the whole file,
 * would hand back that row, or no rows at all, and be wrong in a way a green
 * row count could hide.
 *
 * THE REFUSALS ARE HALF THE CONTRACT. The reader will be pointed at a file a
 * stranger chose, so what it does with a bad one matters as much as what it does
 * with a good one. Every failure must be a `SqliteFormatError`: a `RangeError`
 * or a hang would mean a path nobody bounds. The cycle case is the one that can
 * hang, so it is built on purpose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readTableRows, SqliteFormatError, type SqliteValue } from '#app/lib/local-dictionary/sqlite-table-reader';

/** The page size the fixture was written with, which the premise checks pin. */
const FIXTURE_PAGE_SIZE = 512;

/** `simple_translation`'s root page, where the fixture's interior page sits. */
const SIMPLE_TRANSLATION_ROOT_PAGE = 3;

/** `translation`'s root page, the decoy table's single leaf. */
const DECOY_ROOT_PAGE = 2;

/** B-tree page type of a table interior page. */
const INTERIOR_PAGE_TYPE = 0x05;

/** How many `wortNNNN` rows come before the special rows. */
const PLAIN_ROW_COUNT = 1500;

/** The fixture's whole row count for `simple_translation`. */
const TOTAL_ROW_COUNT = 1503;

/** The length of the `Überlang` row's `trans_list`, which forces an overflow chain. */
const OVERLONG_LENGTH = 12_090;

/** A fresh copy of the fixture, so a test may patch its bytes freely. */
function readFixture(): Uint8Array {
  return Uint8Array.from(readFileSync(new URL('../fixtures/local-dictionary/mini-wikdict.sqlite3', import.meta.url)));
}

/** Every row of one table of a file, read to the end. */
function readAll(bytes: Uint8Array, tableName: string): SqliteValue[][] {
  return [...readTableRows(bytes, tableName)];
}

/** The offset where a one-based page starts in the fixture. */
function fixturePageStart(pageNumber: number): number {
  return (pageNumber - 1) * FIXTURE_PAGE_SIZE;
}

/** Overwrite bytes in a buffer, the way a corrupted or hostile file would differ. */
function patch(bytes: Uint8Array, offset: number, replacement: readonly number[]): Uint8Array {
  bytes.set(replacement, offset);
  return bytes;
}

describe('the fixture is what these cases assume', () => {
  it('has an interior page as the root of simple_translation', () => {
    // If a regenerated fixture put every row on one leaf, the walk would not be
    // exercised by anything below and every case here would still pass.
    const bytes = readFixture();
    assert.equal(bytes[fixturePageStart(SIMPLE_TRANSLATION_ROOT_PAGE)], INTERIOR_PAGE_TYPE);
  });

  it('holds a record far bigger than one page', () => {
    assert.ok(OVERLONG_LENGTH > FIXTURE_PAGE_SIZE * 20);
  });
});

describe('readTableRows reads a real SQLite file', () => {
  it('reads the decoy table from its own root page and nothing else', () => {
    const rows = readAll(readFixture(), 'translation');

    assert.deepEqual(rows, [['x/a__Noun__1', '1', 'decoy', 'decoy', 'nope', 1, 1, 1]]);
  });

  it('reads every row of simple_translation, once each, in rowid order', () => {
    const rows = readAll(readFixture(), 'simple_translation');

    assert.equal(rows.length, TOTAL_ROW_COUNT);
    assert.equal(rows[0]?.[0], 'wort0001');
    assert.equal(rows[PLAIN_ROW_COUNT - 1]?.[0], 'wort1500');
  });

  it('decodes the text, real and real columns of every plain row across the interior pages', () => {
    const rows = readAll(readFixture(), 'simple_translation');

    for (let index = 1; index <= PLAIN_ROW_COUNT; index += 1) {
      const name = `wort${String(index).padStart(4, '0')}`;
      assert.deepEqual(rows[index - 1], [name, `eins${index} | zwei${index} | Hühnchen`, index * 1.5, index / 7]);
    }
  });

  it('reassembles an overflow chain byte for byte', () => {
    const rows = readAll(readFixture(), 'simple_translation');
    const expected = Array.from({ length: 1200 }, (_unused, index) => `lang${index + 1}`).join(' | ');

    assert.equal(expected.length, OVERLONG_LENGTH);
    assert.equal(rows[PLAIN_ROW_COUNT]?.[0], 'Überlang');
    assert.equal(rows[PLAIN_ROW_COUNT]?.[1], expected);
    assert.equal(rows[PLAIN_ROW_COUNT]?.[2], 99);
    assert.equal(rows[PLAIN_ROW_COUNT]?.[3], 1);
  });

  it('keeps NULL columns NULL', () => {
    const rows = readAll(readFixture(), 'simple_translation');

    assert.deepEqual(rows[PLAIN_ROW_COUNT + 1], ['leer', null, null, null]);
  });

  it('decodes the integer serial types as numbers', () => {
    const rows = readAll(readFixture(), 'simple_translation');

    assert.deepEqual(rows[PLAIN_ROW_COUNT + 2], ['Int', 'sieben', 7, 3]);
  });

  it('is lazy about rows but not about the header and the table name', () => {
    const iterator = readTableRows(readFixture(), 'simple_translation');

    assert.deepEqual(iterator.next().value, ['wort0001', 'eins1 | zwei1 | Hühnchen', 1.5, 1 / 7]);
    assert.throws(() => readTableRows(readFixture(), 'no_such_table'), SqliteFormatError);
  });
});

describe('readTableRows refuses what it cannot read, with a SqliteFormatError', () => {
  it('refuses a file with the wrong magic header', () => {
    const bytes = patch(readFixture(), 0, [0x58]);

    assert.throws(() => readAll(bytes, 'simple_translation'), SqliteFormatError);
  });

  it('refuses bytes that are not a database at all', () => {
    assert.throws(() => readAll(new TextEncoder().encode('this is not a database'.repeat(20)), 'simple_translation'), SqliteFormatError);
    assert.throws(() => readAll(new Uint8Array(0), 'simple_translation'), SqliteFormatError);
  });

  it('refuses a truncated buffer at every length, and never throws a RangeError', () => {
    const whole = readFixture();
    const lengths = [0, 10, 99, 100, 511, 512, 1024, 1500, 20_000, whole.length - 1];

    for (const length of lengths) {
      assert.throws(() => readAll(whole.slice(0, length), 'simple_translation'), SqliteFormatError, `length ${length}`);
    }
  });

  it('refuses a truncated buffer whose header page count cannot be trusted', () => {
    // Bytes 92..95 are "version-valid-for". Made unequal to the change
    // counter, the header's own page count is ignored and the walk has to find
    // the missing pages by itself instead of being told about them up front.
    const half = patch(readFixture().slice(0, 114 * FIXTURE_PAGE_SIZE), 92, [0, 0, 0, 99]);

    assert.throws(() => readAll(half, 'simple_translation'), SqliteFormatError);
  });

  it('refuses a table that does not exist', () => {
    assert.throws(() => readAll(readFixture(), 'no_such_table'), SqliteFormatError);
  });

  it('refuses a text encoding other than UTF-8', () => {
    // Bytes 56..59, big-endian: 2 is UTF-16le.
    const bytes = patch(readFixture(), 56, [0, 0, 0, 2]);

    assert.throws(() => readAll(bytes, 'simple_translation'), SqliteFormatError);
  });

  it('refuses a write-ahead-log database', () => {
    const bytes = patch(readFixture(), 18, [2, 2]);

    assert.throws(() => readAll(bytes, 'simple_translation'), SqliteFormatError);
  });

  it('refuses a page size SQLite does not use', () => {
    const bytes = patch(readFixture(), 16, [0x03, 0x00]);

    assert.throws(() => readAll(bytes, 'simple_translation'), SqliteFormatError);
  });

  it('refuses a cell pointer that leaves its page', () => {
    // The decoy table is one leaf with one cell: its first cell pointer sits
    // right behind the 8-byte leaf header. Pointing it at 0xFFFF is past the page.
    const bytes = patch(readFixture(), fixturePageStart(DECOY_ROOT_PAGE) + 8, [0xff, 0xff]);

    assert.throws(() => readAll(bytes, 'translation'), SqliteFormatError);
  });

  it('stops on a b-tree that lists its own root as a child, instead of looping', () => {
    // The right-most pointer of an interior page is the 4 bytes at offset 8 of
    // its header. Making page 3 point at page 3 builds a cycle. A reader that
    // does not bound its walk never returns from this call.
    const bytes = patch(readFixture(), fixturePageStart(SIMPLE_TRANSLATION_ROOT_PAGE) + 8, [0, 0, 0, SIMPLE_TRANSLATION_ROOT_PAGE]);

    assert.throws(() => readAll(bytes, 'simple_translation'), SqliteFormatError);
  });

  it('refuses a child pointer past the last page', () => {
    const bytes = patch(readFixture(), fixturePageStart(SIMPLE_TRANSLATION_ROOT_PAGE) + 8, [0, 0, 0xff, 0xff]);

    assert.throws(() => readAll(bytes, 'simple_translation'), SqliteFormatError);
  });
});
