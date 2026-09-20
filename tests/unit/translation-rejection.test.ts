/**
 * The reason codes and the re-translation cooldown, held to arithmetic.
 *
 * NO ENVIRONMENT PRECONDITION. `app/lib/translation/rejection.ts` imports
 * nothing, so this file reaches no database, no clock and no request: the
 * cooldown predicate takes `now` as an argument precisely so it can be driven
 * across its boundary rather than waited out.
 *
 * THE TUPLE IS ASSERTED MEMBER FOR MEMBER because the database's check
 * constraint is built from it. A member added here without a migration is a
 * code Postgres refuses, and a member removed here is a constraint that still
 * admits a code nothing can produce.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  REJECTION_REASONS,
  RETRANSLATION_COOLDOWN_HOURS,
  isRetranslationCooldownActive,
} from '#app/lib/translation/rejection';

const MS_PER_HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-20T12:00:00.000Z');

/** A stamp `hours` before {@link NOW}. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * MS_PER_HOUR);
}

describe('the rejection reason codes', () => {
  it('are the four the check constraint is built from', () => {
    assert.deepEqual([...REJECTION_REASONS], ['missing', 'wrong', 'register', 'other']);
  });

  it('holds no free-text member', () => {
    for (const reason of REJECTION_REASONS) {
      assert.match(reason, /^[a-z]+$/, `"${reason}" is not a code. A reason is never free text: see the module header.`);
    }
  });
});

describe('the re-translation cooldown', () => {
  it('waits a day', () => {
    assert.equal(RETRANSLATION_COOLDOWN_HOURS, 24);
  });

  it('is not active when the pair was never re-run', () => {
    assert.equal(isRetranslationCooldownActive(null, NOW), false);
  });

  it('is active inside the window', () => {
    assert.equal(isRetranslationCooldownActive(hoursAgo(23), NOW), true);
    assert.equal(isRetranslationCooldownActive(hoursAgo(0), NOW), true);
  });

  it('is not active exactly on the boundary', () => {
    assert.equal(isRetranslationCooldownActive(hoursAgo(RETRANSLATION_COOLDOWN_HOURS), NOW), false);
  });

  it('is not active for an older stamp', () => {
    assert.equal(isRetranslationCooldownActive(hoursAgo(25), NOW), false);
    assert.equal(isRetranslationCooldownActive(hoursAgo(24 * 30), NOW), false);
  });
});
