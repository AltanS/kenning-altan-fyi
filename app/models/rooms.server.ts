/**
 * The rooms a reader has asked for, and the count of paid builds per day.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT, for the reason
 * `app/models/explanations.server.ts` gives: only the type is imported, so
 * importing this file opens no pool.
 *
 * EVERY READ AND WRITE A READER CAN CAUSE IS FILTERED BY THE OWNER. A room id
 * alone finds nothing: another reader's id reads exactly like an id that does
 * not exist.
 *
 * THE THREE JOB WRITES ARE THE ONE EXCEPTION, AND THEY ARE NARROWER STILL.
 * `claimRoomRun`, `setRoomStage` and `finishRoom` are keyed on the id AND the
 * attempt, and they match a `pending` row only. The job carries no reader, and
 * those three conditions are what stop a redelivered or superseded job from
 * paying again or overwriting a newer attempt.
 *
 * EVERY WRITE MOVES `updated_at`, because the stale rule reads it.
 *
 * NOTHING HERE LOGS. A line from this file could pair a reader with a topic.
 */

import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { JsonValue } from '#app/lib/json';
import { roomContentSchema, type RoomContent } from '#app/lib/rooms/content';
import { MAX_ROOM_BUILDS_PER_DAY, ROOM_STALE_MS } from '#app/lib/rooms/limits';
import { ROOM_STAGES, ROOM_STATUSES, type RoomStage, type RoomStatus } from '#app/lib/rooms/view';
import { roomBuildDays, rooms, type SelectRoom } from '#drizzle/schema';

/** How many rooms the list reads. Far past what ten builds a day makes in normal use. */
const ROOM_LIST_LIMIT = 200;

/** One room row, with its text columns narrowed and its document decoded. */
export interface RoomRecord {
  id: string;
  userId: number;
  topic: string;
  termLanguage: string;
  glossLanguage: string;
  status: RoomStatus;
  stage: RoomStage | null;
  attempt: number;
  buildDay: string;
  /** The document, on an `ok` row whose stored content still decodes. Null otherwise. */
  content: RoomContent | null;
  checkedCount: number | null;
  removedCount: number | null;
  provider: string;
  model: string;
  promptVersion: number;
  /** USD, or null before a run has ended. */
  costUsd: number | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/** One row of the reader's list. It carries no document. */
export type RoomSummary = Pick<
  RoomRecord,
  'id' | 'topic' | 'termLanguage' | 'glossLanguage' | 'status' | 'updatedAt' | 'createdAt'
>;

/** The stored status, narrowed. An unknown value reads as `failed`, which stops a screen waiting forever. */
function toStatus(value: string): RoomStatus {
  const parsed = z.enum(ROOM_STATUSES).safeParse(value);
  return parsed.success ? parsed.data : 'failed';
}

function toSummary(row: Omit<RoomSummary, 'status'> & { status: string }): RoomSummary {
  return {
    id: row.id,
    topic: row.topic,
    termLanguage: row.termLanguage,
    glossLanguage: row.glossLanguage,
    status: toStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStage(value: string | null): RoomStage | null {
  const parsed = z.enum(ROOM_STAGES).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toContent(value: JsonValue | null): RoomContent | null {
  const parsed = roomContentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toRecord(row: SelectRoom): RoomRecord {
  return {
    id: row.id,
    userId: row.userId,
    topic: row.topic,
    termLanguage: row.termLanguageCode,
    glossLanguage: row.glossLanguageCode,
    status: toStatus(row.status),
    stage: toStage(row.stage),
    attempt: row.attempt,
    buildDay: row.buildDay,
    content: toContent(row.content ?? null),
    checkedCount: row.checkedCount,
    removedCount: row.removedCount,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Reader reads and writes, all filtered by the owner                          */
/* -------------------------------------------------------------------------- */

export interface RoomIdentity {
  userId: number;
  topicNormalized: string;
  termLanguage: string;
  glossLanguage: string;
}

/** The id of this reader's room for one topic and pair, or null. */
export async function findRoomIdByIdentity(db: DictionaryDb, identity: RoomIdentity): Promise<string | null> {
  const found = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        eq(rooms.userId, identity.userId),
        eq(rooms.topicNormalized, identity.topicNormalized),
        eq(rooms.termLanguageCode, identity.termLanguage),
        eq(rooms.glossLanguageCode, identity.glossLanguage),
      ),
    )
    .limit(1);
  return found[0]?.id ?? null;
}

export interface OwnedRoom {
  userId: number;
  roomId: string;
}

/** The condition every single-room reader query uses: this id AND this owner. */
function ownedBy({ userId, roomId }: OwnedRoom) {
  return and(eq(rooms.id, roomId), eq(rooms.userId, userId));
}

/** This reader's room, or null. A malformed id is null too, so it never reaches the `uuid` column. */
export async function getOwnedRoom(db: DictionaryDb, owned: OwnedRoom): Promise<RoomRecord | null> {
  if (!z.uuid().safeParse(owned.roomId).success) return null;
  const found = await db.select().from(rooms).where(ownedBy(owned)).limit(1);
  const row = found[0];
  return row === undefined ? null : toRecord(row);
}

/** This reader's rooms, newest first. */
export async function listOwnedRooms(db: DictionaryDb, userId: number): Promise<RoomSummary[]> {
  const found = await db
    .select({
      id: rooms.id,
      topic: rooms.topic,
      termLanguage: rooms.termLanguageCode,
      glossLanguage: rooms.glossLanguageCode,
      status: rooms.status,
      createdAt: rooms.createdAt,
      updatedAt: rooms.updatedAt,
    })
    .from(rooms)
    .where(eq(rooms.userId, userId))
    .orderBy(desc(rooms.createdAt))
    .limit(ROOM_LIST_LIMIT);
  return found.map(toSummary);
}

export interface NewRoom extends RoomIdentity {
  topic: string;
  buildDay: string;
  provider: string;
  model: string;
  promptVersion: number;
}

/** Open a `pending` room at attempt 1. Null when this reader already holds this topic and pair. */
export async function insertPendingRoom(db: DictionaryDb, room: NewRoom): Promise<RoomRecord | null> {
  const inserted = await db
    .insert(rooms)
    .values({
      userId: room.userId,
      topic: room.topic,
      topicNormalized: room.topicNormalized,
      termLanguageCode: room.termLanguage,
      glossLanguageCode: room.glossLanguage,
      buildDay: room.buildDay,
      provider: room.provider,
      model: room.model,
      promptVersion: room.promptVersion,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  return row === undefined ? null : toRecord(row);
}

export interface RetryClaim extends OwnedRoom {
  buildDay: string;
  provider: string;
  model: string;
  promptVersion: number;
  now: Date;
}

/**
 * Start the next attempt, in ONE conditional statement, so two presses start one
 * job. It matches a `failed` or `budget` room, or a `pending` one that has not
 * moved for {@link ROOM_STALE_MS}. Null means no attempt was started.
 */
export async function claimRoomRetry(db: DictionaryDb, claim: RetryClaim): Promise<RoomRecord | null> {
  const staleBefore = new Date(claim.now.getTime() - ROOM_STALE_MS);
  const updated = await db
    .update(rooms)
    .set({
      status: 'pending',
      stage: null,
      attempt: sql`${rooms.attempt} + 1`,
      buildDay: claim.buildDay,
      provider: claim.provider,
      model: claim.model,
      promptVersion: claim.promptVersion,
      checkedCount: null,
      removedCount: null,
      costUsd: null,
      error: null,
      updatedAt: claim.now,
      finishedAt: null,
    })
    .where(
      and(
        ownedBy(claim),
        or(
          inArray(rooms.status, ['failed', 'budget']),
          and(eq(rooms.status, 'pending'), lt(rooms.updatedAt, staleBefore)),
        ),
      ),
    )
    .returning();
  const row = updated[0];
  return row === undefined ? null : toRecord(row);
}

/** Delete this reader's room. Null when there was none. The day count is a separate table and stays. */
export async function deleteOwnedRoom(db: DictionaryDb, owned: OwnedRoom): Promise<{ id: string } | null> {
  if (!z.uuid().safeParse(owned.roomId).success) return null;
  const deleted = await db.delete(rooms).where(ownedBy(owned)).returning({ id: rooms.id });
  return deleted[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The job's three writes                                                      */
/* -------------------------------------------------------------------------- */

export interface RoomAttempt {
  roomId: string;
  attempt: number;
}

/** The condition every job write uses: this row, this attempt, still `pending`. */
function currentAttempt({ roomId, attempt }: RoomAttempt) {
  return and(eq(rooms.id, roomId), eq(rooms.attempt, attempt), eq(rooms.status, 'pending'));
}

/**
 * Take the attempt, once. It matches only a row no job has taken (`stage` is
 * null), so a redelivered job finds nothing and pays nothing.
 */
export async function claimRoomRun(db: DictionaryDb, run: RoomAttempt): Promise<RoomRecord | null> {
  const updated = await db
    .update(rooms)
    .set({ stage: 'writing', updatedAt: new Date() })
    .where(and(currentAttempt(run), isNull(rooms.stage)))
    .returning();
  const row = updated[0];
  return row === undefined ? null : toRecord(row);
}

/** Move the running attempt to its next stage. Null when the attempt is no longer current. */
export async function setRoomStage(
  db: DictionaryDb,
  run: RoomAttempt & { stage: RoomStage },
): Promise<{ id: string } | null> {
  const updated = await db
    .update(rooms)
    .set({ stage: run.stage, updatedAt: new Date() })
    .where(currentAttempt(run))
    .returning({ id: rooms.id });
  return updated[0] ?? null;
}

/** How an attempt ended. */
export type RoomOutcome =
  | {
      status: 'ok';
      content: RoomContent;
      checkedCount: number;
      removedCount: number;
      costUsd: number;
      provider: string;
      model: string;
    }
  | {
      status: 'failed' | 'budget';
      error: string;
      costUsd: number;
      checkedCount: number | null;
      removedCount: number | null;
    };

/** The columns each kind of ending writes. `error` is written on both, so no stale text survives. */
function outcomeColumns(outcome: RoomOutcome) {
  if (outcome.status === 'ok') {
    return {
      status: outcome.status,
      content: outcome.content,
      checkedCount: outcome.checkedCount,
      removedCount: outcome.removedCount,
      provider: outcome.provider,
      model: outcome.model,
      error: null,
    };
  }
  return {
    status: outcome.status,
    content: null,
    checkedCount: outcome.checkedCount,
    removedCount: outcome.removedCount,
    error: outcome.error,
  };
}

/**
 * Write the terminal status of one attempt. Null when the attempt is no longer
 * current, in which case nothing was written.
 */
export async function finishRoom(
  db: DictionaryDb,
  run: RoomAttempt & { outcome: RoomOutcome },
): Promise<{ id: string } | null> {
  const now = new Date();
  const updated = await db
    .update(rooms)
    .set({
      ...outcomeColumns(run.outcome),
      stage: null,
      costUsd: run.outcome.costUsd.toFixed(6),
      updatedAt: now,
      finishedAt: now,
    })
    .where(currentAttempt(run))
    .returning({ id: rooms.id });
  return updated[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The per-reader daily count                                                  */
/* -------------------------------------------------------------------------- */

export interface ReaderDay {
  userId: number;
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
}

/** How many builds are counted against this reader on this day. */
export async function countRoomBuilds(db: DictionaryDb, { userId, day }: ReaderDay): Promise<number> {
  const found = await db
    .select({ builds: roomBuildDays.builds })
    .from(roomBuildDays)
    .where(and(eq(roomBuildDays.userId, userId), eq(roomBuildDays.day, day)))
    .limit(1);
  return found[0]?.builds ?? 0;
}

/**
 * Count one build against this reader's day, or refuse.
 *
 * ONE STATEMENT, for the reason `reserve` in the budget module gives: the test
 * and the addition happen together, so parallel requests cannot all see the old
 * count. Null means the cap is reached and nothing was written.
 */
export async function claimRoomBuild(db: DictionaryDb, { userId, day }: ReaderDay): Promise<{ builds: number } | null> {
  const claimed = await db
    .insert(roomBuildDays)
    .values({ userId, day, builds: 1 })
    .onConflictDoUpdate({
      target: [roomBuildDays.userId, roomBuildDays.day],
      set: { builds: sql`${roomBuildDays.builds} + 1` },
      setWhere: lt(roomBuildDays.builds, MAX_ROOM_BUILDS_PER_DAY),
    })
    .returning({ builds: roomBuildDays.builds });
  return claimed[0] ?? null;
}

/**
 * Give one counted build back, for an attempt that never reached the provider.
 * Deleting a room never calls this.
 */
export async function releaseRoomBuild(db: DictionaryDb, { userId, day }: ReaderDay): Promise<void> {
  await db
    .update(roomBuildDays)
    .set({ builds: sql`${roomBuildDays.builds} - 1` })
    .where(and(eq(roomBuildDays.userId, userId), eq(roomBuildDays.day, day), gt(roomBuildDays.builds, 0)));
}
