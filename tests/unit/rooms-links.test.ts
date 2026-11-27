/**
 * Which room terms link to the translator. A link is only honest when the search
 * it leads to is certain to find a headword, so the key and the SQL are pinned
 * against the search path's own.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from '../../drizzle/schema';
import { normalizeForLanguage } from '../../app/lib/dictionary/normalize';
import { existingLemmasQuery } from '../../app/lib/dictionary/search.server';
import { dictionaryLookupKey, selectLinkableTermIds } from '../../app/lib/rooms/dictionary-links';

describe('dictionaryLookupKey', () => {
  it('folds a term the way the search folds a query', () => {
    assert.equal(dictionaryLookupKey({ term: 'Straße', termLanguage: 'de' }), normalizeForLanguage('Straße', 'de'));
    assert.equal(dictionaryLookupKey({ term: 'Işık', termLanguage: 'tr' }), normalizeForLanguage('Işık', 'tr'));
    assert.equal(dictionaryLookupKey({ term: '"Kupfer"?', termLanguage: 'de' }), 'kupfer');
  });

  it('answers nothing for a term the translator would read as a phrase', () => {
    assert.equal(dictionaryLookupKey({ term: 'gelber Sack', termLanguage: 'de' }), null);
  });

  it('answers nothing for a term with no letters', () => {
    assert.equal(dictionaryLookupKey({ term: ' ?! ', termLanguage: 'de' }), null);
  });
});

describe('selectLinkableTermIds', () => {
  it('keeps only the terms the dictionary holds', () => {
    const terms = [
      { id: 't1', term: 'Kupfer' },
      { id: 't2', term: 'Altkupfer' },
      { id: 't3', term: 'gelber Sack' },
      { id: 't4', term: 'Straße' },
    ];

    const ids = selectLinkableTermIds({
      terms,
      termLanguage: 'de',
      existingKeys: new Set(['kupfer', 'strasse', 'gelber sack']),
    });

    assert.deepEqual(ids, ['t1', 't4']);
  });
});

describe('existingLemmasQuery', () => {
  // The pool opens no connection until a query runs, and none does here.
  const db = drizzle(new pg.Pool(), { schema });

  it('asks for every form in one statement, under the exact search conditions', () => {
    const { sql, params } = existingLemmasQuery(db, { normalizedForms: ['kupfer', 'schrott'], from: 'de' }).toSQL();

    assert.match(sql, /"headwords"\."lemma_normalized" in \(\$1, \$2\)/);
    assert.match(sql, /"headwords"\."language_code" = \$3/);
    assert.match(sql, /"sources"\."licence" in/);
    assert.deepEqual(params.slice(0, 3), ['kupfer', 'schrott', 'de']);
  });
});
