/**
 * The settings card's import state machine, and the list of files it links to.
 *
 * WHAT IS PINNED
 *   - A REFUSED NAME READS NOTHING. `de.sqlite3`, `en-en.sqlite3` and a language
 *     Kenning does not serve end in `failed` before the first byte is read, and
 *     the card never asks for a direction instead.
 *   - THE PHASES RUN IN ONE ORDER. idle, reading, indexing, saving, done, and no
 *     action jumps ahead or goes back.
 *   - A FAILURE KEEPS NOTHING. `failed` carries a reason and no pair, no count and
 *     no progress, from every busy phase, and a late progress report cannot revive
 *     a bar after it.
 *   - THE TWELVE LINKS ARE ANCHORS TO THE UPSTREAM HOST, one per ordered pair of
 *     two served languages, with no dash of the kind the design rules forbid.
 *
 * The component itself is a browser shell over this machine and over IndexedDB,
 * neither of which Node can run. The last describe reads its source and refuses
 * the calls that would carry the reader's file out. It is a tripwire, not a proof.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';
import {
  IDLE_CARD_STATE,
  isImportBusy,
  reduceDeviceDictionaryCard,
  type DeviceDictionaryCardAction,
  type DeviceDictionaryCardState,
} from '#app/lib/local-dictionary/card-state';
import { listWikdictDownloads } from '#app/lib/local-dictionary/wikdict-downloads';

/** The repository root, resolved from this file so the working directory is irrelevant. */
const ROOT = join(import.meta.dirname, '../..');

/** Built from its code point on purpose, so this file does not trip `design-rules.test.ts`. */
const EM_DASH = String.fromCodePoint(0x2014);

/** Run the actions in order from a starting state and return every state reached, the start included. */
function walk(start: DeviceDictionaryCardState, actions: readonly DeviceDictionaryCardAction[]): DeviceDictionaryCardState[] {
  const reached = [start];
  for (const action of actions) {
    reached.push(reduceDeviceDictionaryCard(reached.at(-1) ?? start, action));
  }
  return reached;
}

/** The actions of an import that reaches `done`, for the file `de-en.sqlite3`. */
const HAPPY_PATH: readonly DeviceDictionaryCardAction[] = [
  { type: 'file-chosen', fileName: 'de-en.sqlite3' },
  { type: 'read-finished' },
  { type: 'index-built', total: 12 },
  { type: 'save-progress', written: 5, total: 12 },
  { type: 'save-progress', written: 12, total: 12 },
  { type: 'save-finished', entryCount: 12 },
];

describe('a file name the card refuses', () => {
  const refused = [
    ['no direction at all', 'dictionary.sqlite3'],
    ['one code only', 'de.sqlite3'],
    ['the same language twice', 'en-en.sqlite3'],
    ['a language Kenning does not serve', 'fr-de.sqlite3'],
    ['upper case, which a renamed file has', 'DE-EN.sqlite3'],
    ['the wrong extension', 'de-en.csv'],
    ['a path rather than a name', 'downloads/de-en.sqlite3'],
    ['an empty name', ''],
  ] as const;

  for (const [label, fileName] of refused) {
    it(`ends in failed before reading anything: ${label}`, () => {
      const next = reduceDeviceDictionaryCard(IDLE_CARD_STATE, { type: 'file-chosen', fileName });
      assert.deepEqual(next, { phase: 'failed', reason: 'file-name' });
    });
  }

  it('lets the reader try again with a good name straight after', () => {
    const [, refusedState, retried] = walk(IDLE_CARD_STATE, [
      { type: 'file-chosen', fileName: 'oops.sqlite3' },
      { type: 'file-chosen', fileName: 'tr-en.sqlite' },
    ]);
    assert.deepEqual(refusedState, { phase: 'failed', reason: 'file-name' });
    assert.deepEqual(retried, { phase: 'reading', pair: 'tr-en' });
  });
});

describe('the progress order', () => {
  it('runs idle, reading, indexing, saving, done', () => {
    const reached = walk(IDLE_CARD_STATE, HAPPY_PATH);
    assert.deepEqual(
      reached.map((state) => state.phase),
      ['idle', 'reading', 'indexing', 'saving', 'saving', 'saving', 'done'],
    );
  });

  it('takes the direction from the file name and carries it to the end', () => {
    const reached = walk(IDLE_CARD_STATE, HAPPY_PATH);
    assert.deepEqual(reached.at(-1), { phase: 'done', pair: 'de-en', entryCount: 12 });
  });

  it('starts the bar at zero and reports the words written so far', () => {
    const reached = walk(IDLE_CARD_STATE, HAPPY_PATH);
    assert.deepEqual(reached[3], { phase: 'saving', pair: 'de-en', written: 0, total: 12 });
    assert.deepEqual(reached[4], { phase: 'saving', pair: 'de-en', written: 5, total: 12 });
  });

  it('is busy in the three working phases and in no other', () => {
    const phases = walk(IDLE_CARD_STATE, HAPPY_PATH).map((state) => [state.phase, isImportBusy(state)]);
    assert.deepEqual(phases, [
      ['idle', false],
      ['reading', true],
      ['indexing', true],
      ['saving', true],
      ['saving', true],
      ['saving', true],
      ['done', false],
    ]);
  });

  it('ignores an action that skips or reverses a phase', () => {
    const reading = reduceDeviceDictionaryCard(IDLE_CARD_STATE, { type: 'file-chosen', fileName: 'de-en.sqlite3' });
    assert.equal(reduceDeviceDictionaryCard(reading, { type: 'index-built', total: 3 }), reading);
    assert.equal(reduceDeviceDictionaryCard(reading, { type: 'save-progress', written: 1, total: 3 }), reading);
    assert.equal(reduceDeviceDictionaryCard(reading, { type: 'save-finished', entryCount: 3 }), reading);
    assert.equal(reduceDeviceDictionaryCard(IDLE_CARD_STATE, { type: 'read-finished' }), IDLE_CARD_STATE);
    assert.equal(reduceDeviceDictionaryCard(IDLE_CARD_STATE, { type: 'save-finished', entryCount: 3 }), IDLE_CARD_STATE);
  });

  it('does not start a second import while one is running', () => {
    const indexing = walk(IDLE_CARD_STATE, HAPPY_PATH.slice(0, 2)).at(-1);
    assert.ok(indexing);
    assert.equal(reduceDeviceDictionaryCard(indexing, { type: 'file-chosen', fileName: 'en-de.sqlite3' }), indexing);
    assert.equal(reduceDeviceDictionaryCard(indexing, { type: 'file-chosen', fileName: 'nonsense' }), indexing);
  });

  it('starts again from done, and clears done on dismissal', () => {
    const done = walk(IDLE_CARD_STATE, HAPPY_PATH).at(-1);
    assert.ok(done);
    assert.deepEqual(reduceDeviceDictionaryCard(done, { type: 'file-chosen', fileName: 'en-de.sqlite3' }), {
      phase: 'reading',
      pair: 'en-de',
    });
    assert.deepEqual(reduceDeviceDictionaryCard(done, { type: 'dismissed' }), IDLE_CARD_STATE);
  });

  it('does not dismiss a running import', () => {
    const saving = walk(IDLE_CARD_STATE, HAPPY_PATH.slice(0, 4)).at(-1);
    assert.ok(saving);
    assert.equal(reduceDeviceDictionaryCard(saving, { type: 'dismissed' }), saving);
  });
});

describe('a failure keeps nothing', () => {
  const failedAt = [
    ['reading', 1, 'unreadable'],
    ['indexing', 2, 'unreadable'],
    ['saving', 4, 'storage'],
  ] as const;

  for (const [phase, steps, reason] of failedAt) {
    it(`leaves only the reason when it happens while ${phase}`, () => {
      const busy = walk(IDLE_CARD_STATE, HAPPY_PATH.slice(0, steps)).at(-1);
      assert.equal(busy?.phase, phase);
      assert.ok(busy);
      const failed = reduceDeviceDictionaryCard(busy, { type: 'import-failed', reason });
      assert.deepEqual(failed, { phase: 'failed', reason });
      assert.deepEqual(Object.keys(failed).toSorted(), ['phase', 'reason']);
    });
  }

  it('cannot be revived by a progress report that arrives late', () => {
    const failed = walk(IDLE_CARD_STATE, [
      ...HAPPY_PATH.slice(0, 4),
      { type: 'import-failed', reason: 'storage' },
      { type: 'save-progress', written: 9, total: 12 },
      { type: 'save-finished', entryCount: 12 },
    ]).at(-1);
    assert.deepEqual(failed, { phase: 'failed', reason: 'storage' });
  });

  it('is not a failure when nothing was running', () => {
    assert.equal(reduceDeviceDictionaryCard(IDLE_CARD_STATE, { type: 'import-failed', reason: 'storage' }), IDLE_CARD_STATE);
  });

  it('can be dismissed, and a new file starts from scratch', () => {
    const failed: DeviceDictionaryCardState = { phase: 'failed', reason: 'empty' };
    assert.deepEqual(reduceDeviceDictionaryCard(failed, { type: 'dismissed' }), IDLE_CARD_STATE);
    assert.deepEqual(reduceDeviceDictionaryCard(failed, { type: 'file-chosen', fileName: 'es-de.sqlite3' }), {
      phase: 'reading',
      pair: 'es-de',
    });
  });
});

describe('the download links', () => {
  const downloads = listWikdictDownloads();

  it('lists one file for every ordered pair of two different served languages', () => {
    const expected = SERVED_LANGUAGES.flatMap((from) => SERVED_LANGUAGES.filter((to) => to !== from).map((to) => `${from}-${to}`));
    assert.equal(downloads.length, 12);
    assert.deepEqual(downloads.map((download) => download.pair), expected);
  });

  it('points each one at the upstream SQLite file of that direction', () => {
    for (const download of downloads) {
      assert.equal(download.url, `https://download.wikdict.com/dictionaries/sqlite/2/${download.pair}.sqlite3`);
    }
  });

  it('knows an approximate size for every pair', () => {
    const sizes = Object.fromEntries(downloads.map((download) => [download.pair, download.megabytes]));
    assert.deepEqual(sizes, {
      'en-de': 21,
      'en-tr': 8,
      'en-es': 16,
      'de-en': 27,
      'de-tr': 11,
      'de-es': 16,
      'tr-en': 4,
      'tr-de': 3,
      'tr-es': 2,
      'es-en': 11,
      'es-de': 7,
      'es-tr': 3,
    });
  });
});

describe('the card never carries the reader file out', () => {
  const cardSource = readFileSync(join(ROOT, 'app/components/personal/device-dictionary-card.tsx'), 'utf8');
  // The card's own comments name `indexedDB` and "fetch" to explain why it does not use them.
  const cardCode = cardSource.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');

  it('opens no network connection and submits no form', () => {
    const outbound = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|useFetcher|useSubmit|<Form\b|<form\b|FormData/u;
    assert.equal(outbound.test(cardCode), false);
  });

  it('touches the browser only through the store and the cookie helper', () => {
    assert.equal(/\bindexedDB\b|document\./u.test(cardCode), false);
  });

  it('writes no em dash', () => {
    assert.equal(cardSource.includes(EM_DASH), false);
  });
});
