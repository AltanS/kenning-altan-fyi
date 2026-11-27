/**
 * Asking for a room: one room per reader, topic and pair, one job per attempt,
 * the daily cap, the retry claim, and that a room belongs to its owner alone.
 *
 * THE ORCHESTRATOR IS REAL AND THE WORKER IS NOT STARTED, so a build is really
 * queued and nothing drains the queue under the assertions. No provider is
 * involved.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';
import { z } from 'zod';

import { utcDay } from '../../app/lib/abuse/budget.server';
import {
  MAX_ROOM_BUILDS_PER_DAY,
  ROOM_JOB_EXPIRY_SECONDS,
  ROOM_OPERATION_TIMEOUT_MS,
  ROOM_QUEUE,
  ROOM_STALE_MS,
} from '../../app/lib/rooms/limits';
import { createRoom, retryRoom } from '../../app/lib/rooms/service.server';
import { userContext } from '../../app/middleware/context';
import { countRoomBuilds, deleteOwnedRoom, getOwnedRoom, listOwnedRooms } from '../../app/models/rooms.server';
import { loader as apiRoomLoader } from '../../app/routes/api.rooms.$id';
import { action as apiRetryAction } from '../../app/routes/api.rooms.$id.retry';
import { loader as roomLoader } from '../../app/routes/rooms.$id';
import { action as roomsAction } from '../../app/routes/rooms';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { buildRoomTemplate } from '../../app/workflows/templates/build-room';
import { roomBuildDays, rooms, workflows } from '../../drizzle/schema';
import { getRawDb, pool } from '../../drizzle/db';
import { createFakeRoomPort } from '../fixtures/rooms';
import { setUpRoomsEnvironment, type RoomsEnvironment } from '../fixtures/rooms-db';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

let environment: RoomsEnvironment | null = null;
let owner: TestUserSession | null = null;
let stranger: TestUserSession | null = null;
/** Every room any case opened, so the queue rows can be removed. */
const openedRoomIds: string[] = [];

interface Readers {
  owner: TestUserSession;
  stranger: TestUserSession;
}

function sessions(): Readers {
  assert.ok(owner !== null && stranger !== null, 'the fixture accounts were not created');
  return { owner, stranger };
}

/** A request with no cookie and no address, so no rate limit counter is written. */
function anonymousRequest(): Request {
  return new Request('https://kenning.altan.fyi/rooms', { method: 'POST' });
}

async function ask(userId: number, topic: string) {
  const result = await createRoom(db, {
    request: anonymousRequest(),
    userId,
    topic,
    termLanguage: 'de',
    glossLanguage: 'en',
  });
  if (result.kind === 'opened') openedRoomIds.push(result.roomId);
  return result;
}

/** Open a new room for the owner and answer its id. */
async function openRoom(topic: string): Promise<string> {
  const result = await ask(sessions().owner.userId, topic);
  assert.ok(result.kind === 'opened', `expected a new room, got ${JSON.stringify(result)}`);
  return result.roomId;
}

function retry(userId: number, roomId: string) {
  return retryRoom(db, { request: anonymousRequest(), userId, roomId });
}

function builds(userId: number): Promise<number> {
  return countRoomBuilds(db, { userId, day: utcDay(new Date()) });
}

async function setBuilds(userId: number, count: number): Promise<void> {
  await db
    .insert(roomBuildDays)
    .values({ userId, day: utcDay(new Date()), builds: count })
    .onConflictDoUpdate({ target: [roomBuildDays.userId, roomBuildDays.day], set: { builds: count } });
}

async function countJobs(roomId: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from pgboss.job where name = ${ROOM_QUEUE} and singleton_key like ${`room:${roomId}:%`}`,
  );
  const [row] = result.rows;
  return Number(row?.count ?? 0);
}

function routeArgs(request: Request, roomId: string) {
  return { request, url: new URL(request.url), params: { id: roomId }, context: new RouterContextProvider() };
}

/** What `data(null, { status })` throws. */
const dataErrorSchema = z.object({ init: z.object({ status: z.number() }) });

/** The status a route threw, for a call that must be refused. */
async function refusedStatus(call: () => Promise<object>): Promise<number> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof Response) return cause.status;
    // `data(null, { status })` throws a plain wrapper that carries its init.
    return dataErrorSchema.parse(cause).init.status;
  }
  return 200;
}

before(async () => {
  if (!DB_HOST) return;
  environment = await setUpRoomsEnvironment({ port: createFakeRoomPort().port });
  owner = await createTestUserSession('rooms-owner');
  stranger = await createTestUserSession('rooms-stranger');
  await initializeWorkflows();
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  await stopOrchestrator();
  for (const roomId of openedRoomIds) {
    await db.delete(workflows).where(sql`${workflows.context}->>'roomId' = ${roomId}`);
    await db.execute(
      sql`delete from pgboss.job where name = ${ROOM_QUEUE} and singleton_key like ${`room:${roomId}:%`}`,
    );
  }
  if (owner !== null) await owner.dispose();
  if (stranger !== null) await stranger.dispose();
  if (environment !== null) await environment.restore();
  await pool.end();
});

describe('the room queue', () => {
  it('dedupes on its singleton key, and never retries or outlives its expiry', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const result = await db.execute(sql`select policy from pgboss.queue where name = ${ROOM_QUEUE}`);
    assert.equal(String(result.rows[0]?.policy), 'stately');
    assert.equal(buildRoomTemplate.queue, ROOM_QUEUE);
    assert.equal(buildRoomTemplate.queueConfig?.retryLimit, 0);
    assert.equal(buildRoomTemplate.queueConfig?.expireInSeconds, ROOM_JOB_EXPIRY_SECONDS);
    const operations = buildRoomTemplate.stages.flatMap((stage) => stage.operations);
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.maxAttempts, 1);
    assert.equal(operations[0]?.timeout, ROOM_OPERATION_TIMEOUT_MS);
  });
});

describe('asking for a room', () => {
  it('opens one pending room, queues one job and counts one build', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    const countedBefore = await builds(userId);

    const roomId = await openRoom('  Copper recycling  ');

    const room = await getOwnedRoom(db, { userId, roomId });
    assert.equal(room?.topic, 'Copper recycling');
    assert.equal(room?.status, 'pending');
    assert.equal(room?.attempt, 1);
    assert.equal(await countJobs(roomId), 1);
    assert.equal(await builds(userId), countedBefore + 1);
  });

  it('answers the same room again and spends nothing', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    const roomId = await openRoom('glass blowing');
    const countedBefore = await builds(userId);

    const again = await ask(userId, 'GLASS   Blowing');

    assert.deepEqual(again, { kind: 'existing', roomId });
    assert.equal(await builds(userId), countedBefore);
    assert.equal(await countJobs(roomId), 1);
  });

  it('opens one room for a burst of the same request', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    const countedBefore = await builds(userId);

    const results = await Promise.all(Array.from({ length: 4 }, () => ask(userId, 'bee keeping')));

    assert.equal(results.filter((result) => result.kind === 'opened').length, 1);
    assert.equal(results.filter((result) => result.kind === 'existing').length, 3);
    assert.equal(await builds(userId), countedBefore + 1);
  });

  it('gives each reader their own room for one topic', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const roomId = await openRoom('sailing');

    const theirs = await ask(sessions().stranger.userId, 'sailing');

    assert.equal(theirs.kind, 'opened');
    assert.ok(theirs.kind === 'opened');
    assert.notEqual(theirs.roomId, roomId);
  });

  it('refuses a bad request without counting a build', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    const countedBefore = await builds(userId);

    const result = await ask(userId, 'x'.repeat(81));

    assert.deepEqual(result, { kind: 'refused', reason: 'topic-too-long' });
    assert.equal(await builds(userId), countedBefore);
  });

  it('stops at the daily cap, and still opens a room already held', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    const roomId = await openRoom('pottery');
    await setBuilds(userId, MAX_ROOM_BUILDS_PER_DAY);

    assert.deepEqual(await ask(userId, 'weaving'), { kind: 'refused', reason: 'daily-cap' });
    assert.deepEqual(await ask(userId, 'pottery'), { kind: 'existing', roomId });
    assert.equal(await builds(userId), MAX_ROOM_BUILDS_PER_DAY);
    await setBuilds(userId, 0);
  });

  it('gives no build back when a room is deleted', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    const roomId = await openRoom('blacksmithing');
    const countedBefore = await builds(userId);

    assert.deepEqual(await deleteOwnedRoom(db, { userId, roomId }), { id: roomId });

    assert.equal(await builds(userId), countedBefore);
    assert.equal(await getOwnedRoom(db, { userId, roomId }), null);
  });
});

describe('retrying a room', () => {
  it('starts one attempt for two presses', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    await setBuilds(userId, 0);
    const roomId = await openRoom('roofing');
    await db.update(rooms).set({ status: 'failed', stage: null }).where(eq(rooms.id, roomId));

    await Promise.all([retry(userId, roomId), retry(userId, roomId)]);

    const room = await getOwnedRoom(db, { userId, roomId });
    assert.equal(room?.attempt, 2);
    assert.equal(room?.status, 'pending');
    assert.equal(await builds(userId), 2, 'the first attempt and one retry');
    assert.equal(await countJobs(roomId), 2);
  });

  it('leaves a running room alone', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    const roomId = await openRoom('plumbing');
    const countedBefore = await builds(userId);

    const result = await retry(userId, roomId);

    assert.ok(result.kind === 'answered');
    assert.equal(result.room.attempt, 1);
    assert.equal(await builds(userId), countedBefore);
  });

  it('retries a stale pending room', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    const roomId = await openRoom('tiling');
    await db
      .update(rooms)
      .set({ stage: 'writing', updatedAt: new Date(Date.now() - ROOM_STALE_MS - 1000) })
      .where(eq(rooms.id, roomId));

    const result = await retry(userId, roomId);

    assert.ok(result.kind === 'answered');
    assert.equal(result.room.attempt, 2);
    assert.equal(result.room.stage, null);
  });

  it('counts against the daily cap', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { userId } = sessions().owner;
    await setBuilds(userId, 0);
    const roomId = await openRoom('glazing');
    await db.update(rooms).set({ status: 'failed' }).where(eq(rooms.id, roomId));
    await setBuilds(userId, MAX_ROOM_BUILDS_PER_DAY);

    const result = await retry(userId, roomId);

    assert.ok(result.kind === 'answered');
    assert.equal(result.refusal, 'daily-cap');
    assert.equal(result.room.status, 'failed');
    assert.equal(result.room.attempt, 1);
    await setBuilds(userId, 0);
  });
});

describe('a room belongs to its owner', () => {
  it('answers 404 to another reader, on the page and on both API routes', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { owner: mine, stranger: other } = sessions();
    const roomId = await openRoom('carpentry');
    await db.update(rooms).set({ status: 'failed' }).where(eq(rooms.id, roomId));

    const pageRequest = new Request(`https://kenning.altan.fyi/rooms/${roomId}`, { headers: { cookie: other.cookie } });
    assert.equal(
      await refusedStatus(() => roomLoader({ ...routeArgs(pageRequest, roomId), pattern: '/rooms/:id' })),
      404,
    );

    const apiArgs = routeArgs(new Request(`https://kenning.altan.fyi/api/rooms/${roomId}`), roomId);
    apiArgs.context.set(userContext, { id: other.userId, email: other.email, isSuperadmin: false });
    assert.equal(await refusedStatus(() => apiRoomLoader({ ...apiArgs, pattern: '/api/rooms/:id' })), 404);

    const retryRequest = new Request(`https://kenning.altan.fyi/api/rooms/${roomId}/retry`, { method: 'POST' });
    const retryArgs = routeArgs(retryRequest, roomId);
    retryArgs.context.set(userContext, { id: other.userId, email: other.email, isSuperadmin: false });
    assert.equal(
      await refusedStatus(() => apiRetryAction({ ...retryArgs, pattern: '/api/rooms/:id/retry' })),
      404,
    );

    const room = await getOwnedRoom(db, { userId: mine.userId, roomId });
    assert.equal(room?.attempt, 1, 'a stranger must start nothing');
    assert.equal(await deleteOwnedRoom(db, { userId: other.userId, roomId }), null);
    const listed = await listOwnedRooms(db, other.userId);
    assert.equal(listed.some((entry) => entry.id === roomId), false);
  });

  it('answers 404 for an id that is not a room id', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const args = routeArgs(new Request('https://kenning.altan.fyi/api/rooms/nope'), 'nope');
    args.context.set(userContext, { id: sessions().owner.userId, email: 'x@example.invalid', isSuperadmin: false });
    assert.equal(await refusedStatus(() => apiRoomLoader({ ...args, pattern: '/api/rooms/:id' })), 404);
  });

  it('redirects the form to the room it already holds', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const { owner: mine } = sessions();
    const roomId = await openRoom('welding');
    const form = new URLSearchParams({ intent: 'create', topic: 'Welding', termLanguage: 'de', glossLanguage: 'en' });
    const request = new Request('https://kenning.altan.fyi/rooms', {
      method: 'POST',
      headers: { cookie: mine.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    try {
      await roomsAction({
        request,
        url: new URL(request.url),
        params: {},
        pattern: '/rooms',
        context: new RouterContextProvider(),
      });
      assert.fail('the action did not redirect');
    } catch (cause) {
      assert.ok(cause instanceof Response);
      assert.equal(cause.headers.get('location'), `/rooms/${roomId}`);
    }
  });

  it('is removed with the account', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const leaving = await createTestUserSession('rooms-leaving');
    const opened = await ask(leaving.userId, 'farewell');
    assert.equal(opened.kind, 'opened');

    await leaving.dispose();

    const left = await db.select().from(rooms).where(eq(rooms.userId, leaving.userId));
    const counted = await db.select().from(roomBuildDays).where(eq(roomBuildDays.userId, leaving.userId));
    assert.equal(left.length, 0);
    assert.equal(counted.length, 0);
  });
});
