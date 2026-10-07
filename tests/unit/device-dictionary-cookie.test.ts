/**
 * The device-dictionary cookie: the one fact about a device dictionary that the
 * server is allowed to learn.
 *
 * THE SERVER READS THIS WITH NO WAY TO CHECK IT. Anyone can write a cookie, so
 * the parser's whole job is to turn an arbitrary string into a set of pairs the
 * rest of the code can trust: two SERVED, DIFFERENT languages, nothing else. A
 * parser that let `en-en` or `fr-de` through would hand the loader a direction no
 * dictionary can exist for, and the loader would hold a paid model call back for
 * nobody. So most cases below are refusals.
 *
 * THE WRITER IS HELD TO ITS OWN PARSER. The value a browser writes has to be one
 * the server reads back unchanged, so the round trip is asserted, not assumed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_DICTIONARY_COOKIE,
  deviceDictionaryPairKey,
  parseDeviceDictionaryCookie,
  parseDeviceDictionaryPairKey,
  serializeDeviceDictionaryPairs,
  writeDeviceDictionaryCookie,
} from '#app/lib/dictionary/device-dictionary-cookie';

/** The cookie as a request header would carry it. */
function header(value: string): string {
  return `${DEVICE_DICTIONARY_COOKIE}=${value}`;
}

/**
 * Run `body` with a stand-in `document` whose only member is `cookie`, and hand
 * back whatever was last written to it. The same technique, for the same reason,
 * as `tests/unit/language-pair-persistence.test.ts`.
 */
function withDocument(body: () => void): string {
  Object.defineProperty(globalThis, 'document', { value: { cookie: '' }, configurable: true });
  try {
    body();
    return globalThis.document.cookie;
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
}

describe('deviceDictionaryPairKey', () => {
  it('joins the two codes with a hyphen, in direction order', () => {
    assert.equal(deviceDictionaryPairKey('en', 'de'), 'en-de');
    assert.equal(deviceDictionaryPairKey('de', 'en'), 'de-en');
  });

  it('is read back by parseDeviceDictionaryPairKey', () => {
    assert.deepEqual(parseDeviceDictionaryPairKey('tr-es'), { from: 'tr', to: 'es' });
  });

  it('refuses a key that is not two served, different languages', () => {
    for (const key of ['en-en', 'en-fr', 'EN-DE', 'en-de-es', 'ende', 'en-', '-de', '']) {
      assert.equal(parseDeviceDictionaryPairKey(key), null, `"${key}" must not parse`);
    }
  });
});

describe('serializeDeviceDictionaryPairs', () => {
  it('sorts the pairs and joins them with commas', () => {
    assert.equal(serializeDeviceDictionaryPairs(['en-de', 'de-en']), 'de-en,en-de');
  });

  it('writes the same value whatever order the files were imported in', () => {
    assert.equal(serializeDeviceDictionaryPairs(['tr-en', 'es-de', 'en-de']), serializeDeviceDictionaryPairs(['en-de', 'tr-en', 'es-de']));
  });

  it('drops repeats and anything that is not a served direction', () => {
    assert.equal(serializeDeviceDictionaryPairs(['en-de', 'en-de', 'en-en', 'fr-de', 'junk']), 'en-de');
  });

  it('writes an empty value for no pairs', () => {
    assert.equal(serializeDeviceDictionaryPairs([]), '');
  });

  it('accepts a Set, which is what the parser returns', () => {
    assert.equal(serializeDeviceDictionaryPairs(new Set(['es-en', 'en-es'])), 'en-es,es-en');
  });
});

describe('parseDeviceDictionaryCookie', () => {
  it('reads the pairs out of a Cookie header', () => {
    assert.deepEqual([...parseDeviceDictionaryCookie(header('de-en,en-de'))].toSorted(), ['de-en', 'en-de']);
  });

  it('finds its cookie among others', () => {
    const raw = `theme=dark; ${header('en-de')}; translate-pair=detect:de`;

    assert.deepEqual([...parseDeviceDictionaryCookie(raw)], ['en-de']);
  });

  it('reads no pairs from a missing header or a missing cookie', () => {
    assert.equal(parseDeviceDictionaryCookie(null).size, 0);
    assert.equal(parseDeviceDictionaryCookie('').size, 0);
    assert.equal(parseDeviceDictionaryCookie('theme=dark').size, 0);
  });

  it('reads no pairs from an empty value', () => {
    assert.equal(parseDeviceDictionaryCookie(header('')).size, 0);
  });

  it('drops every entry that is not two served, different languages', () => {
    const raw = header('en-en,fr-de,EN-DE,en-de-es,,junk,es-tr');

    assert.deepEqual([...parseDeviceDictionaryCookie(raw)], ['es-tr']);
  });

  it('reads a comma that a client percent-encoded', () => {
    assert.deepEqual([...parseDeviceDictionaryCookie(header('de-en%2Cen-de'))].toSorted(), ['de-en', 'en-de']);
  });

  it('never throws on an undecodable value', () => {
    assert.equal(parseDeviceDictionaryCookie(header('%E0%A4%A')).size, 0);
  });

  it('does not mistake a cookie whose name merely ends the same way', () => {
    assert.equal(parseDeviceDictionaryCookie(`not-${header('en-de')}`).size, 0);
  });
});

describe('writeDeviceDictionaryCookie', () => {
  it('writes a year-long, site-wide, same-site cookie', () => {
    const raw = withDocument(() => writeDeviceDictionaryCookie(['en-de', 'de-en']));

    assert.equal(raw, `${DEVICE_DICTIONARY_COOKIE}=de-en,en-de; Path=/; Max-Age=31536000; SameSite=Lax`);
  });

  it('writes a value the server reads back unchanged', () => {
    const raw = withDocument(() => writeDeviceDictionaryCookie(['tr-en', 'en-tr', 'es-de']));

    assert.deepEqual([...parseDeviceDictionaryCookie(raw.split(';')[0] ?? '')].toSorted(), ['en-tr', 'es-de', 'tr-en']);
  });

  it('is a no-op where there is no document', () => {
    assert.doesNotThrow(() => writeDeviceDictionaryCookie(['en-de']));
  });
});
