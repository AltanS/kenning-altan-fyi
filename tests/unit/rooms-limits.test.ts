/**
 * The time bounds of a room build are one chain. Break the order and either a
 * slow run is cut off after it was paid for, or a reader can start a second paid
 * run beside a live one.
 *
 * That the template carries these numbers is checked in
 * `tests/integration/rooms-access.test.ts`: importing a template opens the
 * database pool, which this tier must not do.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROOM_CALL_DEADLINE_MARGIN_MS,
  ROOM_GENERATE_TIMEOUT_MS,
  ROOM_JOB_EXPIRY_SECONDS,
  ROOM_OPERATION_TIMEOUT_MS,
  ROOM_REVIEW_ATTEMPTS,
  ROOM_REVIEW_TIMEOUT_MS,
  ROOM_STALE_MS,
} from '../../app/lib/rooms/limits';

/** One writer call, then the slower reviewer using every attempt. The two reviewers run side by side. */
const WORST_CASE_MS =
  ROOM_GENERATE_TIMEOUT_MS +
  ROOM_CALL_DEADLINE_MARGIN_MS +
  ROOM_REVIEW_ATTEMPTS * (ROOM_REVIEW_TIMEOUT_MS + ROOM_CALL_DEADLINE_MARGIN_MS);

describe('the room time bounds', () => {
  it('gives the operation longer than the worst run', () => {
    assert.ok(WORST_CASE_MS < ROOM_OPERATION_TIMEOUT_MS);
  });

  it('expires the job after the operation timeout', () => {
    assert.ok(ROOM_OPERATION_TIMEOUT_MS < ROOM_JOB_EXPIRY_SECONDS * 1000);
  });

  it('calls a room stale only after its job has expired', () => {
    assert.ok(ROOM_JOB_EXPIRY_SECONDS * 1000 < ROOM_STALE_MS);
    assert.equal(ROOM_STALE_MS, 10 * 60 * 1000);
  });
});
