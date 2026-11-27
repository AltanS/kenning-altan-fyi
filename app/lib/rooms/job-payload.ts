/**
 * What a queued room build is allowed to say: which row, and which attempt.
 *
 * NO READER AND NO TOPIC. The job reads both off the row. A queue row therefore
 * never pairs a person with what they asked about, and `z.strictObject` makes an
 * extra field a parse error rather than a silently stored one.
 *
 * NO SERVER IMPORTS BELONG HERE, for the reasons
 * `app/lib/translation/explain-job-payload.ts` gives: `#app/workflows/types`
 * reads this shape, and the unit tier has no database.
 */

import { z } from 'zod';

export const roomJobPayloadSchema = z.strictObject({
  roomId: z.uuid(),
  /** The attempt this job was queued for. A job for any other attempt does nothing. */
  attempt: z.number().int().positive(),
});

export type RoomJobPayload = z.infer<typeof roomJobPayloadSchema>;

/** One job per room and attempt. */
export function roomSingletonKey({ roomId, attempt }: RoomJobPayload): string {
  return `room:${roomId}:${attempt}`;
}
