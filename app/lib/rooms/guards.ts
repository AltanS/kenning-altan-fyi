/**
 * The three spend guards a paid room build passes, in their order.
 *
 * THE ORDER IS THE POINT. The two steps before these cost nothing and live in the
 * service: a room that already exists is opened again, and a request outside the
 * bounds is refused. Then:
 *
 *   1. The RATE LIMIT, the per-caller guard. It spends a counter on every call,
 *      so nothing free may come after it.
 *   2. The reader's own DAILY CAP on room builds.
 *   3. The installation's daily BUDGET, last.
 *
 * A guard that refuses stops the ones after it from being asked. The guards are
 * handed in as functions, so a test reads the order off a call log with no
 * database.
 */

import { MAX_ROOM_BUILDS_PER_DAY } from './limits';
import type { RoomRefusal } from './request';

export interface RoomGuardProbes {
  /** Whether the rate limiter lets this caller trigger work. It counts the call. */
  checkRateLimit: () => Promise<{ allowed: boolean }>;
  /** How many builds are counted against this reader today. */
  countBuildsToday: () => Promise<number>;
  /** Whether the installation has spent today's budget. */
  isBudgetExhausted: () => Promise<boolean>;
}

/** Which guard turns this build away, or `null` when none does. */
export async function refuseRoomBuild(probes: RoomGuardProbes): Promise<RoomRefusal | null> {
  const verdict = await probes.checkRateLimit();
  if (!verdict.allowed) return 'rate-limited';
  if ((await probes.countBuildsToday()) >= MAX_ROOM_BUILDS_PER_DAY) return 'daily-cap';
  if (await probes.isBudgetExhausted()) return 'budget';
  return null;
}
