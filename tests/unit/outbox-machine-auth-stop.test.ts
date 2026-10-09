/**
 * How the outbox classifies a refused sync attempt.
 *
 * A 401 and a 412 are both AUTH STOPS: re-running the same request cannot
 * succeed, so the loop stops and the record stays pending rather than backing
 * off and retrying eight times. A 412 means the cookie names another account
 * than the one this device's data belongs to; the record describes the first
 * account's data and must wait for it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyFlushOutcome, classifyFlushOutcome } from '#app/lib/local-store/outbox-machine';
import type { OutboxRecord } from '#app/lib/local-store/types';

const RECORD: OutboxRecord = {
  clientId: 'c1',
  intent: 'sync',
  sequence: 1,
  createdAt: 0,
  status: 'syncing',
  attempts: 0,
  nextAttemptAt: 0,
  lastError: '',
};

describe('classifyFlushOutcome', () => {
  it('treats 401, 403 and 412 as an auth stop', () => {
    for (const status of [401, 403, 412]) {
      assert.equal(classifyFlushOutcome({ ok: false, status }), 'authStop', String(status));
    }
  });

  it('keeps 400 and 413 fatal and everything else transient', () => {
    assert.equal(classifyFlushOutcome({ ok: false, status: 400 }), 'fatal');
    assert.equal(classifyFlushOutcome({ ok: false, status: 413 }), 'fatal');
    assert.equal(classifyFlushOutcome({ ok: false, status: 500 }), 'retry');
    assert.equal(classifyFlushOutcome({ ok: false, status: null }), 'retry');
  });
});

describe('a record that met a 412', () => {
  it('stays pending, with no attempt counted and the loop stopped', () => {
    const outcome = classifyFlushOutcome({ ok: false, status: 412 });
    const transition = applyFlushOutcome({ record: RECORD, outcome, nowMs: 1000 });
    assert.equal(transition.remove, false);
    assert.equal(transition.stop, true);
    assert.equal(transition.surface, 'reauth');
    assert.equal(transition.record?.status, 'pending');
    assert.equal(transition.record?.attempts, 0);
  });
});
