/**
 * What the history and favourites rows call a language.
 *
 * A reviewer saw "fr to English" on a row, a raw code where "Deutsch" and
 * "Türkçe" should have been. French is not a served language, so no row written
 * by this build can carry it, and the lookup falls back to the code for a row an
 * older build stored. Every language the dictionary DOES serve has to resolve to
 * its own name, or the same raw code would appear for a real language the day it
 * is added to `SERVED_LANGUAGES` without a name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';
import { languageName } from '#app/components/personal/saved-word-row';

describe('languageName', () => {
  it('names every served language, and never by its raw code', () => {
    for (const code of SERVED_LANGUAGES) {
      const name = languageName(code);
      assert.notEqual(name, code);
      assert.notEqual(name.trim(), '');
    }
  });

  it('names a language in its own language', () => {
    assert.equal(languageName('de'), 'Deutsch');
    assert.equal(languageName('tr'), 'Türkçe');
    assert.equal(languageName('es'), 'Español');
  });

  it('falls back to the code for a language this build does not serve', () => {
    assert.equal(languageName('fr'), 'fr');
  });
});
