/**
 * Which locale key says each refusal, status and failure reason. `satisfies`
 * makes the maps complete, so a new one fails the typecheck until it has a
 * sentence.
 */

import type { RoomRefusal } from '#app/lib/rooms/request';
import type { RoomFailureReason, RoomStatus } from '#app/lib/rooms/view';

export const ROOM_REFUSAL_KEYS = {
  'topic-too-short': 'rooms.refusal.topicTooShort',
  'topic-too-long': 'rooms.refusal.topicTooLong',
  'unsupported-language': 'rooms.refusal.unsupportedLanguage',
  'same-language': 'rooms.refusal.sameLanguage',
  'rate-limited': 'rooms.refusal.rateLimited',
  'daily-cap': 'rooms.refusal.dailyCap',
  budget: 'rooms.refusal.budget',
} as const satisfies Record<RoomRefusal, string>;

export const ROOM_STATUS_KEYS = {
  pending: 'rooms.status.pending',
  ok: 'rooms.status.ok',
  failed: 'rooms.status.failed',
  budget: 'rooms.status.budget',
} as const satisfies Record<RoomStatus, string>;

export const ROOM_FAILURE_KEYS = {
  budget: 'rooms.reason.budget',
  'removed-too-much': 'rooms.reason.removedTooMuch',
  'no-answer': 'rooms.reason.noAnswer',
} as const satisfies Record<RoomFailureReason, string>;
