/**
 * The signed-in hint: which account's data this device holds, and whether sync
 * is paused.
 *
 * What is pinned:
 *   - it round-trips, and holds nothing but the id and a pause (no address, no
 *     flag), and an OLD `{ userId }` value still parses;
 *   - a value it did not write, or cannot parse, reads as no hint, because it is
 *     read from storage any script on the page could have touched. That includes
 *     a pause with a reason this build does not know: unreadable must never read
 *     as permission to sync;
 *   - every transition of `confirmSignedInHint`, and that `setSyncPause` never
 *     invents a hint;
 *   - a write in THIS tab reaches a subscriber (the browser's `storage` event
 *     does not fire in the tab that wrote);
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
  confirmSignedInHint,
  readSignedInHint,
  replaceSignedInHint,
  setSyncPause,
  subscribeSignedInHint,
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

/** Seeds raw text, bypassing the module, the way an older build or another script would. */
function seed(storage: ReturnType<typeof memoryStorage>, raw: string): void {
  storage.values.set(SIGNED_IN_HINT_KEY, raw);
}

describe('the signed-in hint', () => {
  it('reads as no hint on a browser that has never written one', () => {
    assert.equal(readSignedInHint(memoryStorage()), null);
  });

  it('round-trips the user id through the adopt transition', () => {
    const storage = memoryStorage();
    confirmSignedInHint(42, storage);
    assert.deepEqual(readSignedInHint(storage), { userId: 42 });
  });

  it('stores the id and nothing else when there is no pause', () => {
    const storage = memoryStorage();
    replaceSignedInHint(7, storage);
    assert.deepEqual(JSON.parse(storage.values.get(SIGNED_IN_HINT_KEY) ?? 'null'), { userId: 7 });
  });

  it('replaces the previous hint, pause and all, with a fresh one for another account', () => {
    const storage = memoryStorage();
    replaceSignedInHint(1, storage);
    setSyncPause('expired', storage);
    replaceSignedInHint(2, storage);
    assert.deepEqual(readSignedInHint(storage), { userId: 2 });
  });

  it('forgets the hint on clear, and clearing nothing is fine', () => {
    const storage = memoryStorage();
    clearSignedInHint(storage);
    replaceSignedInHint(5, storage);
    clearSignedInHint(storage);
    assert.equal(readSignedInHint(storage), null);
    assert.equal(storage.values.size, 0);
  });
});

describe('an old hint, written before pauses existed', () => {
  it('still parses, with no pause', () => {
    const storage = memoryStorage();
    seed(storage, '{"userId":11}');
    assert.deepEqual(readSignedInHint(storage), { userId: 11 });
  });

  it('parses a stored pause with both of its known reasons', () => {
    const storage = memoryStorage();
    seed(storage, '{"userId":11,"pause":{"reason":"expired","at":1700000000000}}');
    assert.deepEqual(readSignedInHint(storage), { userId: 11, pause: { reason: 'expired', at: 1700000000000 } });
    seed(storage, '{"userId":11,"pause":{"reason":"other-account","at":5}}');
    assert.deepEqual(readSignedInHint(storage), { userId: 11, pause: { reason: 'other-account', at: 5 } });
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
    ['a pause with a reason this build does not know', '{"userId":9,"pause":{"reason":"banned","at":1}}'],
    ['a pause with no reason', '{"userId":9,"pause":{"at":1}}'],
    ['a pause with no time', '{"userId":9,"pause":{"reason":"expired"}}'],
    ['a pause that is not an object', '{"userId":9,"pause":true}'],
  ];

  for (const [name, raw] of REFUSED) {
    it(`reads ${name} as no hint`, () => {
      const storage = memoryStorage();
      seed(storage, raw);
      assert.equal(readSignedInHint(storage), null);
    });
  }

  it('drops any extra field it is handed, so an address cannot ride along', () => {
    const storage = memoryStorage();
    seed(storage, '{"userId":9,"email":"a@b.de"}');
    assert.deepEqual(readSignedInHint(storage), { userId: 9 });
  });
});

describe('confirmSignedInHint', () => {
  it('adopts the account when the device has no hint', () => {
    const storage = memoryStorage();
    assert.equal(confirmSignedInHint(3, storage), 'adopted');
    assert.deepEqual(readSignedInHint(storage), { userId: 3 });
  });

  it('confirms the same account and leaves a clean hint alone', () => {
    const storage = memoryStorage();
    replaceSignedInHint(3, storage);
    assert.equal(confirmSignedInHint(3, storage), 'confirmed');
    assert.deepEqual(readSignedInHint(storage), { userId: 3 });
  });

  it('removes the pause when the SAME account signs in again', () => {
    const storage = memoryStorage();
    replaceSignedInHint(3, storage);
    setSyncPause('expired', storage);
    assert.equal(confirmSignedInHint(3, storage), 'confirmed');
    assert.deepEqual(readSignedInHint(storage), { userId: 3 });
  });

  it('keeps the old account and pauses sync when a DIFFERENT account signs in', () => {
    const storage = memoryStorage();
    replaceSignedInHint(3, storage);
    assert.equal(confirmSignedInHint(8, storage), 'other-account');
    const hint = readSignedInHint(storage);
    assert.equal(hint?.userId, 3, 'the hint must keep naming the account whose data is on the device');
    assert.equal(hint?.pause?.reason, 'other-account');
    assert.ok(Number.isFinite(hint?.pause?.at), 'the pause carries a time');
  });

  it('keeps an existing pause time when it turns an expired pause into an other-account one', () => {
    const storage = memoryStorage();
    seed(storage, '{"userId":3,"pause":{"reason":"expired","at":1234}}');
    assert.equal(confirmSignedInHint(8, storage), 'other-account');
    assert.deepEqual(readSignedInHint(storage), { userId: 3, pause: { reason: 'other-account', at: 1234 } });
  });

  it('is idempotent for a different account: asking twice changes nothing the second time', () => {
    const storage = memoryStorage();
    seed(storage, '{"userId":3,"pause":{"reason":"other-account","at":99}}');
    assert.equal(confirmSignedInHint(8, storage), 'other-account');
    assert.deepEqual(readSignedInHint(storage), { userId: 3, pause: { reason: 'other-account', at: 99 } });
  });
});

describe('setSyncPause', () => {
  it('records the reason on an existing hint', () => {
    const storage = memoryStorage();
    replaceSignedInHint(4, storage);
    setSyncPause('expired', storage);
    assert.equal(readSignedInHint(storage)?.pause?.reason, 'expired');
    assert.equal(readSignedInHint(storage)?.userId, 4);
  });

  it('overwrites an earlier reason', () => {
    const storage = memoryStorage();
    replaceSignedInHint(4, storage);
    setSyncPause('other-account', storage);
    setSyncPause('expired', storage);
    assert.equal(readSignedInHint(storage)?.pause?.reason, 'expired');
  });

  it('does nothing when there is no hint, so a 401 cannot invent one', () => {
    const storage = memoryStorage();
    setSyncPause('expired', storage);
    assert.equal(readSignedInHint(storage), null);
    assert.equal(storage.values.size, 0);
  });
});

describe('subscribeSignedInHint', () => {
  it('fires in THIS tab for each write and clear', () => {
    const storage = memoryStorage();
    let calls = 0;
    const stop = subscribeSignedInHint(() => {
      calls += 1;
    });

    confirmSignedInHint(1, storage);
    assert.equal(calls, 1, 'adopting writes');
    setSyncPause('expired', storage);
    assert.equal(calls, 2, 'a pause writes');
    confirmSignedInHint(1, storage);
    assert.equal(calls, 3, 'clearing a pause writes');
    replaceSignedInHint(2, storage);
    assert.equal(calls, 4, 'replacing writes');
    clearSignedInHint(storage);
    assert.equal(calls, 5, 'clearing the hint notifies');
    stop();
  });

  it('stays quiet when a write would change nothing', () => {
    const storage = memoryStorage();
    replaceSignedInHint(1, storage);
    let calls = 0;
    const stop = subscribeSignedInHint(() => {
      calls += 1;
    });
    confirmSignedInHint(1, storage);
    replaceSignedInHint(1, storage);
    setSyncPause('expired', storage);
    setSyncPause('expired', storage);
    stop();
    assert.equal(calls, 1, 'only the first pause changed anything');
  });

  it('stops calling once unsubscribed', () => {
    const storage = memoryStorage();
    let calls = 0;
    const stop = subscribeSignedInHint(() => {
      calls += 1;
    });
    stop();
    confirmSignedInHint(1, storage);
    assert.equal(calls, 0);
  });
});

describe('a storage that is missing or blocked', () => {
  it('reads as no hint when there is no storage at all', () => {
    assert.equal(readSignedInHint(null), null);
  });

  it('never throws on read, write, pause, confirm or clear', () => {
    assert.equal(readSignedInHint(BROKEN_STORAGE), null);
    assert.doesNotThrow(() => replaceSignedInHint(3, BROKEN_STORAGE));
    assert.doesNotThrow(() => setSyncPause('expired', BROKEN_STORAGE));
    assert.doesNotThrow(() => confirmSignedInHint(3, BROKEN_STORAGE));
    assert.doesNotThrow(() => clearSignedInHint(BROKEN_STORAGE));
    assert.doesNotThrow(() => replaceSignedInHint(3, null));
    assert.doesNotThrow(() => setSyncPause('expired', null));
    assert.doesNotThrow(() => confirmSignedInHint(3, null));
    assert.doesNotThrow(() => clearSignedInHint(null));
  });

  it('does not tell a subscriber about a write that failed', () => {
    let calls = 0;
    const stop = subscribeSignedInHint(() => {
      calls += 1;
    });
    replaceSignedInHint(3, BROKEN_STORAGE);
    clearSignedInHint(BROKEN_STORAGE);
    stop();
    assert.equal(calls, 0);
  });
});
