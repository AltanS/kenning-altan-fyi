/**
 * The decision behind `useEffectiveUserId`, without a DOM.
 *
 * The hook is wiring over two pure functions, and the whole rule is in them:
 *   - the root data wins whenever it names somebody;
 *   - the offline hint fills in ONLY while the browser is offline, so an online
 *     signed-out visitor never sees a stale reader's tabs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { offlineHintUserId, resolveEffectiveUserId } from '#app/hooks/use-effective-user-id';

describe('offlineHintUserId', () => {
  it('hands back the hint while the browser is offline', () => {
    assert.equal(offlineHintUserId({ isOnline: false, hintUserId: 12 }), 12);
  });

  it('ignores the hint while the browser is online', () => {
    assert.equal(offlineHintUserId({ isOnline: true, hintUserId: 12 }), null);
  });

  it('is nobody when there is no hint, online or not', () => {
    assert.equal(offlineHintUserId({ isOnline: false, hintUserId: null }), null);
    assert.equal(offlineHintUserId({ isOnline: true, hintUserId: null }), null);
  });
});

describe('resolveEffectiveUserId', () => {
  it('prefers the root data when it names somebody', () => {
    assert.equal(resolveEffectiveUserId({ rootUserId: 3, offlineHintUserId: 9 }), 3);
    assert.equal(resolveEffectiveUserId({ rootUserId: 3, offlineHintUserId: null }), 3);
  });

  it('falls back to the offline hint when the root data names nobody', () => {
    assert.equal(resolveEffectiveUserId({ rootUserId: null, offlineHintUserId: 9 }), 9);
  });

  it('is nobody when neither names anybody, which is the online signed-out visitor', () => {
    assert.equal(resolveEffectiveUserId({ rootUserId: null, offlineHintUserId: null }), null);
  });

  it('keeps an online signed-out visitor signed out even with a hint in storage', () => {
    const hint = offlineHintUserId({ isOnline: true, hintUserId: 9 });
    assert.equal(resolveEffectiveUserId({ rootUserId: null, offlineHintUserId: hint }), null);
  });
});
