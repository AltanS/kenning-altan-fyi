/**
 * The signed-in hint: a display-only `{ userId }` the shell reads offline.
 *
 * What is pinned is the hint's three promises:
 *   - it round-trips, and holds NOTHING but the id (no address, no flag);
 *   - a value it did not write, or cannot parse, reads as no hint, because it is
 *     read from storage any script on the page could have touched;
 *   - it never throws, whatever the storage does, because a blocked storage must
 *     not take a screen away.
 *
 * The storage is a `Map`, so no case needs a browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNED_IN_HINT_KEY,
  clearSignedInHint,
  readSignedInHint,
  writeSignedInHint,
  type HintStorage,
} from '#app/lib/auth/signed-in-hint';

/** A `Storage` stand-in that remembers what it was given. */
function memoryStorage(): HintStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** A storage that throws on every call, the way a blocked or full one does. */
const BROKEN_STORAGE: HintStorage = {
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('quota', 'QuotaExceededError');
  },
  removeItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
};

describe('the signed-in hint', () => {
  it('reads as no hint on a browser that has never written one', () => {
    assert.equal(readSignedInHint(memoryStorage()), null);
  });

  it('round-trips the user id', () => {
    const storage = memoryStorage();
    writeSignedInHint(42, storage);
    assert.deepEqual(readSignedInHint(storage), { userId: 42 });
  });

  it('stores the id and nothing else', () => {
    const storage = memoryStorage();
    writeSignedInHint(7, storage);
    assert.deepEqual(JSON.parse(storage.values.get(SIGNED_IN_HINT_KEY) ?? 'null'), { userId: 7 });
  });

  it('replaces the previous hint on a second write', () => {
    const storage = memoryStorage();
    writeSignedInHint(1, storage);
    writeSignedInHint(2, storage);
    assert.deepEqual(readSignedInHint(storage), { userId: 2 });
  });

  it('forgets the hint on clear, and clearing nothing is fine', () => {
    const storage = memoryStorage();
    clearSignedInHint(storage);
    writeSignedInHint(5, storage);
    clearSignedInHint(storage);
    assert.equal(readSignedInHint(storage), null);
    assert.equal(storage.values.size, 0);
  });
});

describe('a stored value this module did not write', () => {
  const REFUSED: [string, string][] = [
    ['not JSON', 'signed-in'],
    ['JSON that is not an object', '42'],
    ['an object without an id', '{"email":"a@b.de"}'],
    ['a string id', '{"userId":"42"}'],
    ['a fractional id', '{"userId":4.5}'],
    ['a zero id', '{"userId":0}'],
    ['a negative id', '{"userId":-3}'],
    ['null', 'null'],
  ];

  for (const [name, raw] of REFUSED) {
    it(`reads ${name} as no hint`, () => {
      const storage = memoryStorage();
      storage.setItem(SIGNED_IN_HINT_KEY, raw);
      assert.equal(readSignedInHint(storage), null);
    });
  }

  it('drops any extra field it is handed, so an address cannot ride along', () => {
    const storage = memoryStorage();
    storage.setItem(SIGNED_IN_HINT_KEY, '{"userId":9,"email":"a@b.de"}');
    assert.deepEqual(readSignedInHint(storage), { userId: 9 });
  });
});

describe('a storage that is missing or blocked', () => {
  it('reads as no hint when there is no storage at all', () => {
    assert.equal(readSignedInHint(null), null);
  });

  it('never throws on read, write or clear', () => {
    assert.equal(readSignedInHint(BROKEN_STORAGE), null);
    assert.doesNotThrow(() => writeSignedInHint(3, BROKEN_STORAGE));
    assert.doesNotThrow(() => clearSignedInHint(BROKEN_STORAGE));
    assert.doesNotThrow(() => writeSignedInHint(3, null));
    assert.doesNotThrow(() => clearSignedInHint(null));
  });
});
