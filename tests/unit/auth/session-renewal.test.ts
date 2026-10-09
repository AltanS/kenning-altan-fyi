/**
 * When the session cookie is renewed.
 *
 * THE THROTTLE IS THE POINT. Renewing on every request would send a `Set-Cookie`
 * with every page and every poll; never renewing would sign an active reader out
 * at the end of the cookie's lifetime. Each case pins one side of the day
 * boundary, and the two odd inputs (an old cookie and a mangled date) both read
 * as "renew", because renewing too eagerly is harmless.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_MAX_AGE_SECONDS,
  SESSION_RENEW_AFTER_MS,
  shouldRenewSession,
} from '../../../app/lib/auth/session-renewal.ts';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const ISSUED_AT = '2026-01-01T00:00:00.000Z';

/** An ISO instant this far before `NOW`. */
function agoMs(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString();
}

describe('shouldRenewSession', () => {
  it('renews a cookie minted before renewedAt existed', () => {
    assert.equal(shouldRenewSession({ id: 1, issuedAt: ISSUED_AT }, NOW), true);
  });

  it('leaves a cookie renewed a moment ago alone', () => {
    assert.equal(shouldRenewSession({ id: 1, issuedAt: ISSUED_AT, renewedAt: agoMs(0) }, NOW), false);
  });

  it('leaves a cookie renewed under 24 hours ago alone', () => {
    const renewedAt = agoMs(SESSION_RENEW_AFTER_MS - 1);
    assert.equal(shouldRenewSession({ id: 1, issuedAt: ISSUED_AT, renewedAt }, NOW), false);
  });

  it('renews a cookie renewed exactly 24 hours ago', () => {
    const renewedAt = agoMs(SESSION_RENEW_AFTER_MS);
    assert.equal(shouldRenewSession({ id: 1, issuedAt: ISSUED_AT, renewedAt }, NOW), true);
  });

  it('renews a cookie renewed over 24 hours ago', () => {
    const renewedAt = agoMs(SESSION_RENEW_AFTER_MS + 1);
    assert.equal(shouldRenewSession({ id: 1, issuedAt: ISSUED_AT, renewedAt }, NOW), true);
  });

  it('renews when renewedAt does not parse', () => {
    assert.equal(shouldRenewSession({ id: 1, issuedAt: ISSUED_AT, renewedAt: 'not a date' }, NOW), true);
    assert.equal(shouldRenewSession({ id: 1, issuedAt: ISSUED_AT, renewedAt: '' }, NOW), true);
  });

  it('ignores issuedAt: an old session renewed today is not due', () => {
    assert.equal(shouldRenewSession({ id: 1, issuedAt: '2020-01-01T00:00:00.000Z', renewedAt: agoMs(1000) }, NOW), false);
  });

  it('does not read a renewal stamped in the future as due', () => {
    const renewedAt = new Date(NOW.getTime() + 60_000).toISOString();
    assert.equal(shouldRenewSession({ id: 1, issuedAt: ISSUED_AT, renewedAt }, NOW), false);
  });
});

describe('the session lifetime', () => {
  it('is 400 days, which is Chrome\'s cap', () => {
    assert.equal(SESSION_MAX_AGE_SECONDS, 400 * 86_400);
  });

  it('renews after one day', () => {
    assert.equal(SESSION_RENEW_AFTER_MS, 86_400_000);
  });
});
