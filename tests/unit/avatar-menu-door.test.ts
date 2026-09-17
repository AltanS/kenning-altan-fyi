/**
 * The header account menu's two decisions, both taken outside the JSX so they
 * can be checked with no DOM. This repo has no DOM test environment, which is
 * exactly why `resolveAvatarMenuDoor` is a function rather than a pair of
 * `&&`s: the rule about which door a reader is offered is the thing worth
 * pinning, and inside the markup it would be untestable here.
 *
 * `isTheme` is the other half. It guards the value Radix hands back from a
 * radio group, and what it must NOT do is answer `system` for a string that is
 * not a theme at all. `themeSchema` does exactly that, deliberately, because
 * reading storage needs a fallback and a callback needs a refusal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAvatarMenuDoor } from '#app/components/avatar-menu';
import { isTheme, nextTheme, THEME_ORDER } from '#app/hooks/use-theme-preference';

describe('resolveAvatarMenuDoor', () => {
  it('offers the way out to a reader who is signed in', () => {
    assert.equal(resolveAvatarMenuDoor({ isSignedIn: true }), 'sign-out');
  });

  it('offers the way in to a reader who is not', () => {
    assert.equal(resolveAvatarMenuDoor({ isSignedIn: false }), 'sign-in');
  });
});

describe('nextTheme', () => {
  it('walks system, light, dark', () => {
    assert.equal(nextTheme('system'), 'light');
    assert.equal(nextTheme('light'), 'dark');
  });

  it('wraps back to system, so a reader can hand the decision back', () => {
    assert.equal(nextTheme('dark'), 'system');
  });

  it('reaches every state from every state', () => {
    for (const start of THEME_ORDER) {
      const walked = new Set([start]);
      let current = start;
      for (let step = 0; step < THEME_ORDER.length; step += 1) {
        current = nextTheme(current);
        walked.add(current);
      }
      assert.deepEqual([...walked].toSorted(), THEME_ORDER.toSorted());
    }
  });
});

describe('isTheme', () => {
  it('accepts each shipped theme', () => {
    for (const theme of THEME_ORDER) {
      assert.equal(isTheme(theme), true, theme);
    }
  });

  it('refuses anything else rather than falling back to system', () => {
    for (const value of ['', 'System', 'sepia', 'auto', 'light ']) {
      assert.equal(isTheme(value), false, value);
    }
  });
});
