/**
 * The device-dictionary engine against a REAL WikDict file.
 *
 * WHY THIS EXISTS BESIDE THE FIXTURE TEST. `mini-wikdict.sqlite3` is 512-byte
 * pages and 1503 rows, built to force interior pages and an overflow chain. A
 * real WikDict pair file is 4096-byte pages, 20 MB, 124,751 rows, with a b-tree
 * several levels deep and a free-page layout nobody designed. The reader passed
 * the first and could still be wrong on the second, in a way only the real thing
 * shows: a page-1 offset slip that only matters when `sqlite_schema` outgrows
 * its first leaf, a cell-pointer assumption that holds at 512 and not at 4096.
 * So the milestone's own check reads the real file.
 *
 * THE FILE IS NOT IN THE REPOSITORY. It is CC BY-SA data the reader brings to
 * the app, and the repository does not carry it either. Download
 * `en-de.sqlite3` from WikDict's download page, then point `WIKDICT_PROBE` at it:
 *
 *   WIKDICT_PROBE=/tmp/wikdict-probe/en-de.sqlite3 node --import tsx --test \
 *     tests/integration/local-dictionary-real-file.test.ts
 *
 * Without the variable every case skips. A SKIP IS NOT A PASS for this check:
 * the milestone's checklist item is only met by a run that set the variable.
 * The precondition is declared inline at each case, because
 * `tests/unit/integration-tests-self-skip.test.ts` reads this file as text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildWikdictIndex } from '#app/lib/local-dictionary/wikdict';
import { readTableRows } from '#app/lib/local-dictionary/sqlite-table-reader';

const WIKDICT_PROBE = process.env.WIKDICT_PROBE;

/** The row count of `simple_translation` in the 2026-10-07 `en-de` file, read with `sqlite3`. */
const EXPECTED_ROW_COUNT = 124_751;

/** The probe file's bytes. Called only inside a case that did not skip. */
function readProbe(): Uint8Array {
  if (!WIKDICT_PROBE) throw new Error('WIKDICT_PROBE is not set');
  return Uint8Array.from(readFileSync(WIKDICT_PROBE));
}

describe('a real WikDict en-de file', () => {
  it('yields every row of simple_translation', { skip: !WIKDICT_PROBE ? 'WIKDICT_PROBE not set' : false }, () => {
    let count = 0;
    for (const row of readTableRows(readProbe(), 'simple_translation')) {
      count += 1;
      assert.equal(row.length, 4, `row ${count} has ${row.length} columns`);
    }

    assert.equal(count, EXPECTED_ROW_COUNT);
  });

  it('maps house to an entry whose translations include Haus', { skip: !WIKDICT_PROBE ? 'WIKDICT_PROBE not set' : false }, () => {
    const entries = buildWikdictIndex(readProbe(), { from: 'en' });
    const house = entries.find((entry) => entry.key === 'house');

    assert.ok(house, 'the index has no entry for house');
    assert.ok(house.translations.includes('Haus'), `house translates to ${house.translations.join(' | ')}`);
    assert.equal(house.written, 'house');
  });

  it('gives every entry a unique key and at least one translation', { skip: !WIKDICT_PROBE ? 'WIKDICT_PROBE not set' : false }, () => {
    const entries = buildWikdictIndex(readProbe(), { from: 'en' });
    const keys = new Set(entries.map((entry) => entry.key));

    assert.equal(keys.size, entries.length);
    assert.ok(entries.length > 0);
    assert.ok(entries.every((entry) => entry.translations.length > 0 && entry.key !== ''));
  });
});
