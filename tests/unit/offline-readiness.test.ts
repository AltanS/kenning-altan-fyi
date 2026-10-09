/**
 * `needsHomeScreenAdvice`, the one decision in the "Offline use" card that is
 * worth pinning: the iPhone sentence must appear for a reader whose saved data
 * Safari will delete after a week, and for nobody else.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { needsHomeScreenAdvice, type HomeScreenAdviceInputs } from '#app/lib/offline/readiness';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

function inputs(overrides: Partial<HomeScreenAdviceInputs>): HomeScreenAdviceInputs {
  return { userAgent: ANDROID_UA, platform: 'Linux armv81', maxTouchPoints: 5, isStandalone: false, ...overrides };
}

describe('needsHomeScreenAdvice', () => {
  it('is true for an iPhone in a browser tab', () => {
    assert.equal(needsHomeScreenAdvice(inputs({ userAgent: IPHONE_UA, platform: 'iPhone' })), true);
  });

  it('is false for an iPhone that runs the installed app', () => {
    assert.equal(needsHomeScreenAdvice(inputs({ userAgent: IPHONE_UA, platform: 'iPhone', isStandalone: true })), false);
  });

  it('is true for an iPad that asks for desktop sites, which reports a Mac with a touch screen', () => {
    assert.equal(needsHomeScreenAdvice(inputs({ userAgent: MAC_UA, platform: 'MacIntel', maxTouchPoints: 5 })), true);
  });

  it('is false for a real Mac, which has no touch points', () => {
    assert.equal(needsHomeScreenAdvice(inputs({ userAgent: MAC_UA, platform: 'MacIntel', maxTouchPoints: 0 })), false);
  });

  it('is false for Android and for a desktop browser', () => {
    assert.equal(needsHomeScreenAdvice(inputs({})), false);
    assert.equal(needsHomeScreenAdvice(inputs({ platform: 'Win32', maxTouchPoints: 0 })), false);
  });
});
