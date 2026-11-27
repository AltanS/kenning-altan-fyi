/**
 * The room page and the poll route link only the terms the dictionary holds,
 * against real rows.
 *
 * THIS FILE WRITES one temporary source with two headwords and one reader, and
 * removes all of them. The lemmas carry a run-unique tail no import produces.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { normalizeForLanguage } from '../../app/lib/dictionary/normalize';
import { identifyDraft } from '../../app/lib/rooms/decide';
import { roomViewSchema } from '../../app/lib/rooms/view';
import { userContext } from '../../app/middleware/context';
import { claimRoomRun, finishRoom, insertPendingRoom } from '../../app/models/rooms.server';
import { loader as apiRoomLoader } from '../../app/routes/api.rooms.$id';
import { loader as roomLoader } from '../../app/routes/rooms.$id';
import { headwords, sources } from '../../drizzle/schema';
import { getRawDb, pool, poolInitialized } from '../../drizzle/db';
import { buildRoomDraft } from '../fixtures/rooms';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const RUN_ID = Math.random().toString(16).slice(2, 10);
const HELD = `Straßenkupfer${RUN_ID}`;
const WITHDRAWN = `Altkupfer${RUN_ID}`;

let reader: TestUserSession | null = null;
const sourceIds: string[] = [];

/** One temporary source holding one German headword. */
async function seedHeadword({ lemma, licence }: { lemma: string; licence: string }): Promise<void> {
  const [source] = await db
    .insert(sources)
    .values({ slug: `rooms-links-${lemma}`, name: 'Rooms links test', licence, attribution: 'test' })
    .returning({ id: sources.id });
  assert.ok(source !== undefined, 'the temporary source was not created');
  sourceIds.push(source.id);
  await db.insert(headwords).values({
    languageCode: 'de',
    lemma,
    lemmaNormalized: normalizeForLanguage(lemma, 'de'),
    sourceId: source.id,
  });
}

before(async () => {
  if (!DB_HOST) return;
  await poolInitialized;
  reader = await createTestUserSession('rooms-links');
  await seedHeadword({ lemma: HELD, licence: 'CC0-1.0' });
  // A word from a licence the app does not serve is not found by a search either.
  await seedHeadword({ lemma: WITHDRAWN, licence: 'LicenseRef-not-served' });
});

after(async () => {
  for (const sourceId of sourceIds) {
    await db.delete(headwords).where(eq(headwords.sourceId, sourceId));
    await db.delete(sources).where(eq(sources.id, sourceId));
  }
  if (reader !== null) await reader.dispose();
  await pool.end();
});

describe('the links of a room', () => {
  it('names only the terms the dictionary holds, on the page and on the poll route', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    assert.ok(reader !== null, 'the fixture account was not created');
    const room = await insertPendingRoom(db, {
      userId: reader.userId,
      topic: 'links',
      topicNormalized: 'links',
      termLanguage: 'de',
      glossLanguage: 'en',
      buildDay: '2026-01-01',
      provider: 'openrouter',
      model: 'test-model',
      promptVersion: 1,
    });
    assert.ok(room !== null);
    const draft = buildRoomDraft({ terms: 3 });
    const words = [HELD, WITHDRAWN, 'Gibtesnicht'];
    const groups = draft.groups.map((group) => ({
      ...group,
      terms: group.terms.map((term, index) => ({ ...term, term: words[index] ?? term.term })),
    }));
    const run = { roomId: room.id, attempt: room.attempt };
    await claimRoomRun(db, run);
    await finishRoom(db, {
      ...run,
      outcome: {
        status: 'ok',
        content: identifyDraft({ draft: { ...draft, groups }, termLanguage: 'de' }),
        checkedCount: 3,
        removedCount: 0,
        costUsd: 0,
        provider: 'openrouter',
        model: 'test-model',
      },
    });

    const request = new Request(`https://kenning.altan.fyi/rooms/${room.id}`, { headers: { cookie: reader.cookie } });
    const page = await roomLoader({
      request,
      url: new URL(request.url),
      params: { id: room.id },
      pattern: '/rooms/:id',
      context: new RouterContextProvider(),
    });
    assert.deepEqual(page.room.linkableTermIds, ['t1']);

    const context = new RouterContextProvider();
    context.set(userContext, { id: reader.userId, email: reader.email, isSuperadmin: false });
    const apiRequest = new Request(`https://kenning.altan.fyi/api/rooms/${room.id}`);
    const response = await apiRoomLoader({
      request: apiRequest,
      url: new URL(apiRequest.url),
      params: { id: room.id },
      pattern: '/api/rooms/:id',
      context,
    });
    assert.deepEqual(roomViewSchema.parse(await response.json()).linkableTermIds, ['t1']);
  });
});
