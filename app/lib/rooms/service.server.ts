/**
 * Asking for a room, and asking for another attempt at one. These two functions
 * are the only places a room build is ever started.
 *
 * AN EXISTING ROOM IS ANSWERED FIRST. The same topic and pair from the same
 * reader opens the room they already hold and spends nothing, not even a rate
 * limit counter. Then the free checks, then the three guards in `guards.ts`.
 *
 * THE COUNTED BUILD AND THE ROW ARE ONE TRANSACTION, which closes before the job
 * is sent: pg-boss sends on its own connection.
 *
 * A BUILD THAT CANNOT BE QUEUED ENDS `failed` AT ONCE and is given back to the
 * reader's day, so nobody waits ten minutes for a job that does not exist.
 *
 * NO LOG LINE PAIRS A READER WITH A TOPIC.
 */

import { isBudgetExhausted, utcDay } from '#app/lib/abuse/budget.server';
import { checkTriggerRateLimit } from '#app/lib/abuse/rate-limit.server';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { createComponentLogger } from '#app/lib/logger';
import { getActiveModel } from '#app/models/app-settings.server';
import {
  claimRoomBuild,
  claimRoomRetry,
  countRoomBuilds,
  findRoomIdByIdentity,
  finishRoom,
  getOwnedRoom,
  insertPendingRoom,
  releaseRoomBuild,
  type NewRoom,
  type RoomRecord,
} from '#app/models/rooms.server';
import { ROOM_PROMPT_VERSION } from '#app/prompts/room/version';

import { findLinkableTermIds } from './dictionary-links.server';
import { enqueueRoomBuild } from './enqueue.server';
import { refuseRoomBuild } from './guards';
import { checkRoomRequest, normalizeRoomTopic, type RoomRefusal, type RoomRequestInput } from './request';
import { isRoomRetryable, roomFailureReason, type RoomView } from './view';

const log = createComponentLogger('Rooms');

/** A row as the room screen and the poll route read it, with the dictionary asked which terms it holds. */
export async function loadRoomView(db: DictionaryDb, room: RoomRecord, now: Date = new Date()): Promise<RoomView> {
  const content = room.status === 'ok' ? room.content : null;
  const linkableTermIds =
    content === null ? [] : await findLinkableTermIds(db, { content, termLanguage: room.termLanguage });
  return {
    id: room.id,
    topic: room.topic,
    termLanguage: room.termLanguage,
    glossLanguage: room.glossLanguage,
    status: room.status,
    stage: room.stage,
    canRetry: isRoomRetryable(room, now),
    failureReason: roomFailureReason(room),
    content,
    linkableTermIds,
    removedCount: room.removedCount,
  };
}

interface Caller {
  /** The request that asked, for the rate limiter. */
  request: Request;
  userId: number;
}

/** The three guards, wired to the real counters. */
function refuseFor(db: DictionaryDb, { request, userId }: Caller, day: string): Promise<RoomRefusal | null> {
  return refuseRoomBuild({
    checkRateLimit: () => checkTriggerRateLimit(request),
    countBuildsToday: () => countRoomBuilds(db, { userId, day }),
    isBudgetExhausted: () => isBudgetExhausted(),
  });
}

/** Send the job for the row's current attempt, or end that attempt when it cannot be sent. */
async function queueBuild(db: DictionaryDb, room: RoomRecord): Promise<void> {
  const run = { roomId: room.id, attempt: room.attempt };
  try {
    await enqueueRoomBuild(run);
  } catch (cause) {
    log.warn('A room build was not queued', {
      ...run,
      errorName: cause instanceof Error ? cause.name : 'unknown',
    });
    const ended = await finishRoom(db, {
      ...run,
      outcome: {
        status: 'failed',
        error: 'The build could not be queued',
        costUsd: 0,
        checkedCount: null,
        removedCount: null,
      },
    });
    if (ended !== null) await releaseRoomBuild(db, { userId: room.userId, day: room.buildDay });
  }
}

export type CreateRoomResult =
  | { kind: 'opened'; roomId: string }
  | { kind: 'existing'; roomId: string }
  | { kind: 'refused'; reason: RoomRefusal };

export type CreateRoomParams = Caller & RoomRequestInput;

type OpenResult =
  | { kind: 'opened'; room: RoomRecord }
  | { kind: 'existing'; roomId: string }
  | { kind: 'refused'; reason: RoomRefusal };

/** Count the build and open the row. Runs inside one transaction. */
async function openRoom(db: DictionaryDb, room: NewRoom): Promise<OpenResult> {
  const readerDay = { userId: room.userId, day: room.buildDay };
  const counted = await claimRoomBuild(db, readerDay);
  if (counted === null) return { kind: 'refused', reason: 'daily-cap' };

  const opened = await insertPendingRoom(db, room);
  if (opened !== null) return { kind: 'opened', room: opened };

  // A parallel request opened this room first. Theirs is the build, so ours is
  // not counted.
  await releaseRoomBuild(db, readerDay);
  const roomId = await findRoomIdByIdentity(db, room);
  if (roomId === null) throw new Error('A room insert conflicted, but no room holds that identity');
  return { kind: 'existing', roomId };
}

/** Open the reader's room for a topic and pair, starting a build only when there is none yet. */
export async function createRoom(db: DictionaryDb, params: CreateRoomParams): Promise<CreateRoomResult> {
  const { userId, termLanguage, glossLanguage } = params;
  const topic = params.topic.trim();
  const identity = { userId, topicNormalized: normalizeRoomTopic(topic), termLanguage, glossLanguage };

  const existingId = await findRoomIdByIdentity(db, identity);
  if (existingId !== null) return { kind: 'existing', roomId: existingId };

  const checked = checkRoomRequest({ topic, termLanguage, glossLanguage });
  if (!checked.ok) return { kind: 'refused', reason: checked.reason };

  const buildDay = utcDay(new Date());
  const refusal = await refuseFor(db, params, buildDay);
  if (refusal !== null) return { kind: 'refused', reason: refusal };

  const active = await getActiveModel();
  const opened = await db.transaction((tx) =>
    openRoom(tx, {
      ...identity,
      topic,
      buildDay,
      provider: active.provider,
      model: active.model,
      promptVersion: ROOM_PROMPT_VERSION,
    }),
  );
  if (opened.kind !== 'opened') return opened;

  await queueBuild(db, opened.room);
  return { kind: 'opened', roomId: opened.room.id };
}

export type RetryRoomResult =
  | { kind: 'not-found' }
  /** Where the room stands now. `refusal` names the guard that turned the retry away. */
  | { kind: 'answered'; room: RoomRecord; refusal: RoomRefusal | null };

export type RetryRoomParams = Caller & { roomId: string };

/**
 * Start another attempt at a `failed`, `budget` or stale room. A room in any
 * other state is answered as it stands, and nothing is counted.
 */
export async function retryRoom(db: DictionaryDb, params: RetryRoomParams): Promise<RetryRoomResult> {
  const { userId, roomId } = params;
  const room = await getOwnedRoom(db, { userId, roomId });
  if (room === null) return { kind: 'not-found' };

  const now = new Date();
  if (!isRoomRetryable(room, now)) return { kind: 'answered', room, refusal: null };

  const buildDay = utcDay(now);
  const refusal = await refuseFor(db, params, buildDay);
  if (refusal !== null) return { kind: 'answered', room, refusal };

  const active = await getActiveModel();
  const claim = await db.transaction(async (tx) => {
    const counted = await claimRoomBuild(tx, { userId, day: buildDay });
    if (counted === null) return { kind: 'refused' as const };
    const claimed = await claimRoomRetry(tx, {
      userId,
      roomId,
      buildDay,
      provider: active.provider,
      model: active.model,
      promptVersion: ROOM_PROMPT_VERSION,
      now,
    });
    if (claimed === null) {
      // Another press took the retry between the read above and this statement.
      await releaseRoomBuild(tx, { userId, day: buildDay });
      return { kind: 'lost' as const };
    }
    // A stale attempt no job ever took can never run now, so it never spends.
    // The claim above only matches while the row is still stale, which proves no
    // job took it since it was read.
    if (room.status === 'pending' && room.stage === null) {
      await releaseRoomBuild(tx, { userId, day: room.buildDay });
    }
    return { kind: 'claimed' as const, room: claimed };
  });

  if (claim.kind === 'claimed') await queueBuild(db, claim.room);

  const latest = await getOwnedRoom(db, { userId, roomId });
  if (latest === null) return { kind: 'not-found' };
  return { kind: 'answered', room: latest, refusal: claim.kind === 'refused' ? 'daily-cap' : null };
}
