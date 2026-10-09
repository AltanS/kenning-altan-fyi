/**
 * The sync decision: may this page sync, and for whom?
 *
 * One pure function, so the table below IS the specification. The cases that
 * matter most are the quiet ones: a pause must win over everything, a different
 * account must hold sync back even before the confirm step has written anything,
 * and a root answer that names nobody must never be read as an expired session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { SignedInHint } from '#app/lib/auth/signed-in-hint';
import { decideSyncSession, type SyncDecision } from '#app/lib/sync/sync-decision';

const CLEAN: SignedInHint = { userId: 5 };
const EXPIRED: SignedInHint = { userId: 5, pause: { reason: 'expired', at: 1 } };
const OTHER: SignedInHint = { userId: 5, pause: { reason: 'other-account', at: 1 } };

interface Row {
  name: string;
  rootUserId: number | null;
  isOnline: boolean;
  hint: SignedInHint | null;
  expected: SyncDecision;
}

const TABLE: Row[] = [
  { name: 'no hint, live root names a user: the confirm step writes the hint first', rootUserId: 5, isOnline: true, hint: null, expected: { kind: 'none' } },
  { name: 'no hint, nobody signed in', rootUserId: null, isOnline: true, hint: null, expected: { kind: 'none' } },
  { name: 'no hint, offline', rootUserId: null, isOnline: false, hint: null, expected: { kind: 'none' } },
  { name: 'an expired pause beats a root answer naming the same account', rootUserId: 5, isOnline: true, hint: EXPIRED, expected: { kind: 'paused', reason: 'expired' } },
  { name: 'an expired pause holds offline too', rootUserId: 5, isOnline: false, hint: EXPIRED, expected: { kind: 'paused', reason: 'expired' } },
  { name: 'an other-account pause is reported with its reason', rootUserId: 9, isOnline: true, hint: OTHER, expected: { kind: 'paused', reason: 'other-account' } },
  { name: 'a pause wins over an offline fallback root', rootUserId: 5, isOnline: false, hint: OTHER, expected: { kind: 'paused', reason: 'other-account' } },
  { name: 'a root naming a DIFFERENT account is paused as other-account, computed with no write', rootUserId: 9, isOnline: true, hint: CLEAN, expected: { kind: 'paused', reason: 'other-account' } },
  { name: 'a different account is paused offline as well', rootUserId: 9, isOnline: false, hint: CLEAN, expected: { kind: 'paused', reason: 'other-account' } },
  { name: 'online, the root names the hint account: sync', rootUserId: 5, isOnline: true, hint: CLEAN, expected: { kind: 'sync', userId: 5 } },
  { name: 'offline fallback root (its id is the hint id): sync, the cycle fails quietly on transport', rootUserId: 5, isOnline: false, hint: CLEAN, expected: { kind: 'sync', userId: 5 } },
  { name: 'offline, the root names nobody: the hint stands in', rootUserId: null, isOnline: false, hint: CLEAN, expected: { kind: 'sync', userId: 5 } },
  { name: 'ONLINE with a root that names nobody is NOT an expired session: none', rootUserId: null, isOnline: true, hint: CLEAN, expected: { kind: 'none' } },
];

describe('decideSyncSession', () => {
  for (const row of TABLE) {
    it(row.name, () => {
      assert.deepEqual(
        decideSyncSession({ rootUserId: row.rootUserId, isOnline: row.isOnline, hint: row.hint }),
        row.expected,
      );
    });
  }

  it('never names a user other than the hint account', () => {
    for (const row of TABLE) {
      const decision = decideSyncSession({ rootUserId: row.rootUserId, isOnline: row.isOnline, hint: row.hint });
      if (decision.kind === 'sync') assert.equal(decision.userId, row.hint?.userId, row.name);
    }
  });
});
