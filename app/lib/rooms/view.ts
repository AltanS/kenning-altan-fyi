/**
 * What a room looks like to a screen, and the rules read off a row: its state,
 * whether it may be retried, and why it has no document.
 *
 * PURE, AND SAFE FOR THE CLIENT BUNDLE. The room page parses the polled body
 * with `roomViewSchema`, and the tests read the retry rule with a fixed clock.
 */

import { z } from 'zod';

import { roomContentSchema } from './content';
import { ROOM_STALE_MS } from './limits';
import { ROOM_REFUSALS } from './request';

/** The four states of a room row. Everything but `pending` is terminal for its attempt. */
export const ROOM_STATUSES = ['pending', 'ok', 'failed', 'budget'] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** The two steps of a running build, for the progress display. */
export const ROOM_STAGES = ['writing', 'checking'] as const;

export type RoomStage = (typeof ROOM_STAGES)[number];

export interface RetryableRoom {
  status: RoomStatus;
  updatedAt: Date;
}

/**
 * Whether a new attempt may be started: after `failed` or `budget`, or on a
 * `pending` row that has not moved for longer than {@link ROOM_STALE_MS}.
 *
 * `claimRoomRetry` states the same rule as a SQL condition, which is the one
 * that actually decides. This one decides what the screen offers.
 */
export function isRoomRetryable(room: RetryableRoom, now: Date): boolean {
  if (room.status === 'failed' || room.status === 'budget') return true;
  if (room.status !== 'pending') return false;
  return now.getTime() - room.updatedAt.getTime() > ROOM_STALE_MS;
}

/** Why an attempt ended without a room, as far as a reader is told. */
export const ROOM_FAILURE_REASONS = ['budget', 'removed-too-much', 'no-answer'] as const;

export type RoomFailureReason = (typeof ROOM_FAILURE_REASONS)[number];

export interface EndedRoom {
  status: RoomStatus;
  checkedCount: number | null;
}

/**
 * The reason, read off two columns and NEVER off `rooms.error`, which is
 * operator text and may quote a provider. Only a run the reviewers judged leaves
 * a count on a `failed` row. Null for a room that did not end that way.
 */
export function roomFailureReason({ status, checkedCount }: EndedRoom): RoomFailureReason | null {
  if (status === 'budget') return 'budget';
  if (status !== 'failed') return null;
  return checkedCount === null ? 'no-answer' : 'removed-too-much';
}

/** The body of `GET /api/rooms/:id`, and what the room page renders from. */
export const roomViewSchema = z.object({
  id: z.string(),
  topic: z.string(),
  termLanguage: z.string(),
  glossLanguage: z.string(),
  status: z.enum(ROOM_STATUSES),
  stage: z.enum(ROOM_STAGES).nullable(),
  /** Whether the retry button belongs on screen. */
  canRetry: z.boolean(),
  /** Why a `failed` or `budget` room has no document, or null. */
  failureReason: z.enum(ROOM_FAILURE_REASONS).nullable(),
  /** The document, on an `ok` room whose stored content still decodes. */
  content: roomContentSchema.nullable(),
  /** The ids of the terms the dictionary holds, which are the ones the page links. */
  linkableTermIds: z.array(z.string()),
  removedCount: z.number().nullable(),
});

export type RoomView = z.infer<typeof roomViewSchema>;

/** The body of `POST /api/rooms/:id/retry`: where the room stands now, and why no attempt was started. */
export const roomRetryResponseSchema = z.object({
  room: roomViewSchema,
  refusal: z.enum(ROOM_REFUSALS).nullable(),
});

export type RoomRetryResponse = z.infer<typeof roomRetryResponseSchema>;
