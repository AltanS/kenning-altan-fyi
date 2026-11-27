/**
 * Small rules of the Rooms screens: language names follow the interface, "hide
 * translations" and what was revealed are remembered per room, and a failed room
 * says why without its stored error text.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PAIR_LANGUAGES } from '../../app/lib/dictionary/language-pair';
import { localizedLanguageName } from '../../app/lib/rooms/language-names';
import {
  readItemRevealed,
  readTranslationsHidden,
  revealItem,
  writeTranslationsHidden,
} from '../../app/lib/rooms/practice-preference';
import { roomFailureReason } from '../../app/lib/rooms/view';

function namesIn(uiLanguage: string): string[] {
  return PAIR_LANGUAGES.map((code) => localizedLanguageName({ code, uiLanguage }));
}

function installStorage(storage: Pick<Storage, 'getItem' | 'setItem'>): void {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
}

function refuse(): never {
  throw new Error('storage is blocked');
}

describe('localizedLanguageName', () => {
  it('names the served languages in the interface language', () => {
    assert.deepEqual(namesIn('de'), ['Englisch', 'Deutsch', 'Türkisch', 'Spanisch']);
    assert.deepEqual(namesIn('en'), ['English', 'German', 'Turkish', 'Spanish']);
  });
});

describe('hidden translations', () => {
  const stored = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

  afterEach(() => {
    stored.clear();
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
      return;
    }
    Object.defineProperty(globalThis, 'sessionStorage', original);
  });

  it('is kept for one room and not for another', () => {
    installStorage({
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
    });

    writeTranslationsHidden({ roomId: 'a', isHidden: true });

    assert.equal(readTranslationsHidden('a'), true);
    assert.equal(readTranslationsHidden('b'), false);
    writeTranslationsHidden({ roomId: 'a', isHidden: false });
    assert.equal(readTranslationsHidden('a'), false);
  });

  it('keeps what was revealed for one room, until the switch is flipped', () => {
    installStorage({
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
    });
    writeTranslationsHidden({ roomId: 'a', isHidden: true });

    revealItem({ roomId: 'a', itemId: 't1' });
    revealItem({ roomId: 'a', itemId: 's2' });

    assert.equal(readItemRevealed({ roomId: 'a', itemId: 't1' }), true);
    assert.equal(readItemRevealed({ roomId: 'a', itemId: 's2' }), true);
    assert.equal(readItemRevealed({ roomId: 'a', itemId: 't2' }), false);
    assert.equal(readItemRevealed({ roomId: 'b', itemId: 't1' }), false);

    writeTranslationsHidden({ roomId: 'a', isHidden: false });
    writeTranslationsHidden({ roomId: 'a', isHidden: true });

    assert.equal(readItemRevealed({ roomId: 'a', itemId: 't1' }), false);
  });

  it('still switches when storage is refused', () => {
    installStorage({ getItem: refuse, setItem: refuse });

    assert.equal(readTranslationsHidden('c'), false);
    writeTranslationsHidden({ roomId: 'c', isHidden: true });

    assert.equal(readTranslationsHidden('c'), true);
    revealItem({ roomId: 'c', itemId: 'r1' });
    assert.equal(readItemRevealed({ roomId: 'c', itemId: 'r1' }), true);
  });
});

describe('roomFailureReason', () => {
  it('reads the reason off the status and the checked count', () => {
    assert.equal(roomFailureReason({ status: 'budget', checkedCount: null }), 'budget');
    assert.equal(roomFailureReason({ status: 'failed', checkedCount: 20 }), 'removed-too-much');
    assert.equal(roomFailureReason({ status: 'failed', checkedCount: null }), 'no-answer');
  });

  it('gives no reason for a room that is pending or built', () => {
    assert.equal(roomFailureReason({ status: 'pending', checkedCount: null }), null);
    assert.equal(roomFailureReason({ status: 'ok', checkedCount: 20 }), null);
  });
});
