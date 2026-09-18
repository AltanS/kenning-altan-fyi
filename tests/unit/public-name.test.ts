/**
 * The public-name fold and the one check on its shape.
 *
 * PURE, LIKE THE MODULE UNDER TEST. No database, no request, no clock, every
 * case here is arithmetic on a string.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { APP_NAME } from '../../app/lib/app-name.ts';
import {
  foldPublicName,
  parsePublicName,
  PUBLIC_NAME_MAX_CHARS,
  PUBLIC_NAME_MIN_CHARS,
} from '../../app/lib/authorship/public-name.ts';

describe('the public-name fold', () => {
  it('trims and lower-cases, mirroring normalizeEmail', () => {
    assert.equal(foldPublicName('  Reader Name '), 'reader name');
  });

  it('folds two names differing only in case to the same value', () => {
    assert.equal(foldPublicName('Käthe'), foldPublicName('KÄTHE'.toLowerCase()));
    assert.equal(foldPublicName('Reader'), foldPublicName('READER'));
    assert.equal(foldPublicName('Reader'), foldPublicName('reader'));
  });
});

describe('the length boundary', () => {
  it('refuses one character under the floor, after trimming', () => {
    assert.equal(parsePublicName('a'.repeat(PUBLIC_NAME_MIN_CHARS - 1)), null);
    assert.equal(parsePublicName(`  ${'a'.repeat(PUBLIC_NAME_MIN_CHARS - 1)}  `), null);
  });

  it('accepts exactly the floor', () => {
    assert.equal(parsePublicName('a'.repeat(PUBLIC_NAME_MIN_CHARS)), 'a'.repeat(PUBLIC_NAME_MIN_CHARS));
  });

  it('accepts exactly the ceiling', () => {
    const name = 'a'.repeat(PUBLIC_NAME_MAX_CHARS);
    assert.equal(parsePublicName(name), name);
  });

  it('refuses one character over the ceiling, after trimming', () => {
    assert.equal(parsePublicName('a'.repeat(PUBLIC_NAME_MAX_CHARS + 1)), null);
  });

  it('measures the bound after trimming, not before', () => {
    // Untrimmed this is over the ceiling; trimmed it is exactly at it.
    const padded = `  ${'a'.repeat(PUBLIC_NAME_MAX_CHARS)}  `;
    assert.equal(parsePublicName(padded), 'a'.repeat(PUBLIC_NAME_MAX_CHARS));
  });

  it('returns the trimmed form, never the folded one', () => {
    assert.equal(parsePublicName('  Reader Name  '), 'Reader Name');
  });
});

describe('the character set', () => {
  it('accepts letters, digits, spaces, hyphens, underscores and periods', () => {
    assert.equal(parsePublicName('Reader_One-2.0'), 'Reader_One-2.0');
  });

  it('accepts a real name carrying an accented Unicode letter', () => {
    assert.equal(parsePublicName('Jörg'), 'Jörg');
    assert.equal(parsePublicName('Müller'), 'Müller');
  });

  it('refuses a disallowed character', () => {
    assert.equal(parsePublicName('Reader!'), null);
    assert.equal(parsePublicName('Reader@Name'), null);
    assert.equal(parsePublicName('Reader/Name'), null);
  });

  it('refuses a control character', () => {
    assert.equal(parsePublicName('Reader\nName'), null);
    assert.equal(parsePublicName('Reader\tName'), null);
  });
});

describe('folding preserves diacritics, and only normalizes case', () => {
  it('folds a name and its shouted form to one key', () => {
    assert.equal(foldPublicName('Jörg'), foldPublicName('JÖRG'));
  });

  it('does NOT fold a diacritic and its ASCII transliteration to one key', () => {
    assert.notEqual(foldPublicName('Jörg'), foldPublicName('Joerg'));
  });
});

describe('the reserved list', () => {
  it('refuses every hand-typed reserved word, case-insensitively', () => {
    for (const word of ['admin', 'Administrator', 'MODERATOR', 'Operator', 'support', 'Staff', 'system']) {
      assert.equal(parsePublicName(word), null, `expected "${word}" to be reserved`);
    }
    for (const word of ['official', 'Anonymous', 'UNKNOWN', 'null', 'undefined', 'root', 'owner']) {
      assert.equal(parsePublicName(word), null, `expected "${word}" to be reserved`);
    }
  });

  it("refuses the product's own name, folded, and with surrounding whitespace", () => {
    assert.equal(parsePublicName(APP_NAME), null);
    assert.equal(parsePublicName(APP_NAME.toLowerCase()), null);
    assert.equal(parsePublicName(APP_NAME.toUpperCase()), null);
    assert.equal(parsePublicName(`${APP_NAME.toUpperCase()} `), null);
  });

  it('refuses "Kenning" and "KENNING " specifically', () => {
    assert.equal(parsePublicName('Kenning'), null);
    assert.equal(parsePublicName('KENNING '), null);
  });
});
