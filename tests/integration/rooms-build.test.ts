/**
 * The room job: what it stores, how it ends, what it spends, and that one
 * attempt is paid for at most once.
 *
 * The job body is driven directly. No queue and no worker are involved, and the
 * provider is a fake port with one answer queue per role.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { DAILY_BUDGET_USD, utcDay } from '../../app/lib/abuse/budget.server';
import { registry } from '../../app/lib/llm/registry.server';
import { countRoomTerms } from '../../app/lib/rooms/content';
import { claimRoomBuild, claimRoomRetry, countRoomBuilds, getOwnedRoom, insertPendingRoom } from '../../app/models/rooms.server';
import { runBuildRoom } from '../../app/workflows/operations/rooms/build-room';
import { dailyBudget, rooms } from '../../drizzle/schema';
import { getRawDb, pool } from '../../drizzle/db';
import { llmError, llmValue } from '../fixtures/fake-llm-port';
import { buildRoomDraft, buildRoomReview, createFakeRoomPort, roomItemIds, type FakeRoomResponses } from '../fixtures/rooms';
import { setUpRoomsEnvironment, type RoomsEnvironment } from '../fixtures/rooms-db';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const IDS = roomItemIds();
const ACCEPT_ALL = llmValue(buildRoomReview({ ids: IDS }), 0.002);
const WRITTEN = llmValue(buildRoomDraft(), 0.01);

let environment: RoomsEnvironment | null = null;
let session: TestUserSession | null = null;
let topicNumber = 0;

function userId(): number {
  assert.ok(session !== null, 'the fixture account was not created');
  return session.userId;
}

/** Install the answers one case needs. */
function program(responses: FakeRoomResponses) {
  const fake = createFakeRoomPort(responses);
  registry.withProvider(fake.port);
  return fake;
}

/** A counted, pending room, as the create form leaves it, with no job queued. */
async function openRoom() {
  topicNumber += 1;
  const buildDay = utcDay(new Date());
  await claimRoomBuild(db, { userId: userId(), day: buildDay });
  const room = await insertPendingRoom(db, {
    userId: userId(),
    topic: `copper recycling ${topicNumber}`,
    topicNormalized: `copper recycling ${topicNumber}`,
    termLanguage: 'de',
    glossLanguage: 'en',
    buildDay,
    provider: 'gemini',
    model: 'google/gemini-3.8-flash',
    promptVersion: 1,
  });
  assert.ok(room, 'the room was not opened');
  return room;
}

async function readRoom(roomId: string) {
  const room = await getOwnedRoom(db, { userId: userId(), roomId });
  assert.ok(room, 'the room disappeared');
  return room;
}

async function readBudget() {
  const [row] = await db
    .select()
    .from(dailyBudget)
    .where(eq(dailyBudget.day, utcDay(new Date())));
  return { reservedUsd: Number(row?.reservedUsd ?? 0), spentUsd: Number(row?.spentUsd ?? 0) };
}

function builds(): Promise<number> {
  return countRoomBuilds(db, { userId: userId(), day: utcDay(new Date()) });
}

before(async () => {
  if (!DB_HOST) return;
  environment = await setUpRoomsEnvironment({ port: createFakeRoomPort().port });
  session = await createTestUserSession('rooms-build');
});

beforeEach(async () => {
  if (!DB_HOST) return;
  await db.delete(dailyBudget).where(eq(dailyBudget.day, utcDay(new Date())));
});

after(async () => {
  if (session !== null) await session.dispose();
  if (environment !== null) await environment.restore();
  await pool.end();
});

describe('a room build', () => {
  it('stores what both reviewers accept, and the cost of all three calls', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const fake = program({
      writer: [WRITTEN],
      language: [llmValue(buildRoomReview({ ids: IDS, rejected: ['t1'] }), 0.002)],
      subject: [llmValue(buildRoomReview({ ids: IDS, rejected: ['r1'] }), 0.003)],
    });
    const opened = await openRoom();

    const summary = await runBuildRoom({ roomId: opened.id, attempt: 1 });

    assert.equal(summary.outcome, 'written');
    assert.equal(fake.totalCalls(), 3);
    const room = await readRoom(opened.id);
    assert.equal(room.status, 'ok');
    assert.equal(room.stage, null);
    assert.equal(room.error, null);
    assert.ok(room.finishedAt);
    assert.ok(room.content, 'the stored document does not decode');
    assert.equal(countRoomTerms(room.content), 11);
    assert.equal(room.content.rules.length, 1);
    assert.equal(room.checkedCount, 20);
    assert.equal(room.removedCount, 2);
    assert.equal(room.costUsd, 0.015);
    const budget = await readBudget();
    assert.equal(budget.reservedUsd, 0, 'every reservation must be settled');
    assert.equal(budget.spentUsd, 0.015);
  });

  it('asks a failed reviewer a second time', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const fake = program({ writer: [WRITTEN], language: [llmError('boom'), ACCEPT_ALL], subject: [ACCEPT_ALL] });
    const opened = await openRoom();

    const summary = await runBuildRoom({ roomId: opened.id, attempt: 1 });

    assert.equal(summary.outcome, 'written');
    assert.equal(fake.language.callCount, 2);
    assert.equal(summary.providerCalls, 4);
    const budget = await readBudget();
    assert.equal(budget.reservedUsd, 0);
    assert.ok(budget.spentUsd > 0.014, 'the failed attempt is settled at its estimate, on top of the three costs');
  });

  it('fails closed when a reviewer fails both attempts', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const fake = program({ writer: [WRITTEN], language: [ACCEPT_ALL], subject: [llmError('one'), llmError('two')] });
    const opened = await openRoom();
    const countedBefore = await builds();

    const summary = await runBuildRoom({ roomId: opened.id, attempt: 1 });

    assert.equal(summary.outcome, 'failed');
    assert.equal(fake.subject.callCount, 2);
    const room = await readRoom(opened.id);
    assert.equal(room.status, 'failed');
    assert.equal(room.content, null);
    assert.match(room.error ?? '', /subject reviewer/);
    assert.ok((room.costUsd ?? 0) > 0);
    assert.equal(await builds(), countedBefore, 'a paid attempt stays counted');
    assert.equal((await readBudget()).reservedUsd, 0);
  });

  it('fails and stores no content when too little survives', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    program({
      writer: [WRITTEN],
      language: [llmValue(buildRoomReview({ ids: IDS, rejected: ['t1', 't2', 't3'] }), 0.002)],
      subject: [ACCEPT_ALL],
    });
    const opened = await openRoom();

    const summary = await runBuildRoom({ roomId: opened.id, attempt: 1 });

    assert.equal(summary.outcome, 'failed');
    const room = await readRoom(opened.id);
    assert.equal(room.status, 'failed');
    assert.equal(room.content, null);
    assert.equal(room.checkedCount, 20);
    assert.equal(room.removedCount, 3);
  });

  it('fails without asking a reviewer when the writer call fails', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const fake = program({ writer: [llmError('no answer')] });
    const opened = await openRoom();

    const summary = await runBuildRoom({ roomId: opened.id, attempt: 1 });

    assert.equal(summary.outcome, 'failed');
    assert.equal(fake.totalCalls(), 1);
    assert.equal((await readRoom(opened.id)).status, 'failed');
    assert.equal((await readBudget()).reservedUsd, 0);
  });

  it('ends budget, calls nothing and gives the build back when the day is spent', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const fake = program({});
    const opened = await openRoom();
    const countedBefore = await builds();
    await db.insert(dailyBudget).values({ day: utcDay(new Date()), spentUsd: DAILY_BUDGET_USD.toFixed(6) });

    const summary = await runBuildRoom({ roomId: opened.id, attempt: 1 });

    assert.equal(summary.outcome, 'budget');
    assert.equal(fake.totalCalls(), 0);
    const room = await readRoom(opened.id);
    assert.equal(room.status, 'budget');
    assert.equal(room.costUsd, 0);
    assert.equal(await builds(), countedBefore - 1);
  });

  it('pays nothing on a redelivery', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const fake = program({ writer: [WRITTEN], language: [ACCEPT_ALL], subject: [ACCEPT_ALL] });
    const opened = await openRoom();
    const payload = { roomId: opened.id, attempt: 1 };

    const [first, second] = await Promise.all([runBuildRoom(payload), runBuildRoom(payload)]);
    const third = await runBuildRoom(payload);

    assert.deepEqual([first.outcome, second.outcome].toSorted(), ['skipped', 'written']);
    assert.equal(third.outcome, 'skipped');
    assert.equal(third.providerCalls, 0);
    assert.equal(fake.totalCalls(), 3);
  });

  it('does nothing for an attempt a retry has replaced', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const fake = program({});
    const opened = await openRoom();
    await db.update(rooms).set({ status: 'failed' }).where(eq(rooms.id, opened.id));
    const retried = await claimRoomRetry(db, {
      userId: userId(),
      roomId: opened.id,
      buildDay: utcDay(new Date()),
      provider: 'gemini',
      model: 'google/gemini-3.8-flash',
      promptVersion: 1,
      now: new Date(),
    });
    assert.equal(retried?.attempt, 2);

    const summary = await runBuildRoom({ roomId: opened.id, attempt: 1 });

    assert.equal(summary.outcome, 'skipped');
    assert.equal(fake.totalCalls(), 0);
    const room = await readRoom(opened.id);
    assert.equal(room.status, 'pending');
    assert.equal(room.attempt, 2);
  });

  it('never lets an older attempt overwrite a newer one', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const opened = await openRoom();
    const fake = createFakeRoomPort({ writer: [WRITTEN] });
    // The room is retried while the writer of attempt 1 is still answering.
    registry.withProvider({
      complete: async (request) => {
        await db.update(rooms).set({ attempt: 2, stage: null }).where(eq(rooms.id, opened.id));
        return fake.port.complete(request);
      },
    });

    const summary = await runBuildRoom({ roomId: opened.id, attempt: 1 });

    assert.equal(summary.outcome, 'skipped');
    assert.equal(fake.totalCalls(), 1, 'a superseded attempt must not pay for its reviews');
    const room = await readRoom(opened.id);
    assert.equal(room.status, 'pending');
    assert.equal(room.attempt, 2);
    assert.equal(room.content, null);
    assert.equal(room.costUsd, null);
  });
});
