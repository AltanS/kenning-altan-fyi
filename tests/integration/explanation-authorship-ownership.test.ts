/**
 * A READER WHO IS NOT THE AUTHOR OF THE ROW THEY WERE SERVED CANNOT PUBLISH IT
 * (M200).
 *
 * THE SCENARIO IS THE REAL ONE, NOT AN INVENTED ONE. Two readers ask the same
 * question. The ledger is keyed by the question alone and carries no reader, so
 * both asks resolve to ONE answer, and exactly one of them caused the row that
 * answered it. The other reader owns their own `explanation_asks` row, opens
 * `/explanations/:id` legitimately, and is served an answer somebody else's
 * attempt produced. They must be able to change nothing about it.
 *
 * IT DRIVES THE REAL ROUTE, WITH REAL SESSION COOKIES, the shape
 * `settings-profile-actions.test.ts` established. The claim is about what the
 * action does with an ask id out of the path and a form body it does not trust,
 * so calling the model layer directly would prove none of it.
 *
 * THE FORGED BODY IS THE POINT OF THE SECOND CASE. The non-author posts the
 * REAL `explanationId` in the form, which is the value the naive design would
 * have used. The action never reads it: the row it writes to is re-derived from
 * the ask id in the path, through `resolveOwnAuthorship`.
 *
 * NO ORCHESTRATOR AND NO MODEL CALL. The answered row is written straight
 * through the model layer, `insertPendingExplanation` then `settleExplanation`,
 * because what is under test starts once an answer exists.
 *
 * ISOLATION. One run-scoped question, two fixture users, all taken away in
 * `after`. Deleting the ledger rows cascades onto the authorship row; disposing
 * a user cascades onto their asks.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { explanationAsks, explanationAuthorship, explanations } from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { normalizeQuery } from '../../app/lib/dictionary/normalize';
import type { Explanation } from '../../app/lib/llm/explain-schema';
import { recordExplanationAsk } from '../../app/models/explanation-asks.server';
import { insertExplanationAuthorship } from '../../app/models/explanation-authorship.server';
import { insertPendingExplanation, settleExplanation } from '../../app/models/explanations.server';
import { action, loader, type ExplanationDetailActionResult } from '../../app/routes/explanations.$id';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;
const ORIGIN = 'https://kenning.altan.fyi';

const db = getRawDb();

const FROM = 'de';
const TO = 'en';

/** A run-scoped suffix, so a repeat run of this file writes a fresh cache key. */
const RUN = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;
const question = `Was bedeutet zzownership${RUN} in diesem Satz?`;
const questionNormalized = normalizeQuery(question, FROM).normalized;

/** The smallest document the card will draw. */
const answer: Explanation = {
  answer: 'It is a placeholder written by this test, not by a model.',
  terms: [],
  contrasts: [],
  pitfalls: [],
  related: [],
  references: [],
};

let author: TestUserSession | null = null;
let stranger: TestUserSession | null = null;
let explanationId = '';
let authorAskId = 0;
let strangerAskId = 0;

/** Every argument the router hands an action or a loader, for one request. */
function routeArgs(request: Request, askId: number) {
  return {
    request,
    url: new URL(request.url),
    params: { id: String(askId) },
    pattern: '/explanations/:id',
    context: new RouterContextProvider(),
  };
}

/** Posts a form to the detail route, exactly as one of the two switches does. */
async function submit(
  fields: Record<string, string>,
  cookie: string,
  askId: number,
): Promise<ExplanationDetailActionResult> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);

  const headers = new Headers();
  headers.set('cookie', cookie);

  const request = new Request(`${ORIGIN}/explanations/${askId}`, { method: 'POST', headers, body });
  return action(routeArgs(request, askId));
}

/** The stored flags, read straight off the table. */
async function storedFlags() {
  const [row] = await db
    .select({
      userId: explanationAuthorship.userId,
      listed: explanationAuthorship.listed,
      showName: explanationAuthorship.showName,
    })
    .from(explanationAuthorship)
    .where(eq(explanationAuthorship.explanationId, explanationId));
  return row ?? null;
}

/** One reader's ask id for this question. */
async function askIdFor(userId: number): Promise<number> {
  const [row] = await db
    .select({ id: explanationAsks.id })
    .from(explanationAsks)
    .where(and(eq(explanationAsks.userId, userId), eq(explanationAsks.questionNormalized, questionNormalized)))
    .limit(1);
  return row?.id ?? 0;
}

before(async () => {
  if (!DB_HOST) return;

  author = await createTestUserSession('authorship-owner');
  stranger = await createTestUserSession('authorship-stranger');

  explanationId = await insertPendingExplanation(db, {
    from: FROM,
    to: TO,
    question,
    questionNormalized,
    promptVersion: 2,
    provider: 'openrouter',
    model: 'a-model',
  });
  await settleExplanation(db, explanationId, { status: 'ok', answer });
  await insertExplanationAuthorship(db, { explanationId, userId: author.userId, listed: true });

  // Both readers asked the same question, which is what makes one of them a
  // non-author of the row they are both served.
  for (const userId of [author.userId, stranger.userId]) {
    await recordExplanationAsk({
      userId,
      question,
      questionNormalized,
      fromLanguage: FROM,
      toLanguage: TO,
    });
  }
  authorAskId = await askIdFor(author.userId);
  strangerAskId = await askIdFor(stranger.userId);
});

after(async () => {
  if (DB_HOST) {
    await db
      .delete(explanations)
      .where(
        and(
          eq(explanations.fromLanguageCode, FROM),
          eq(explanations.toLanguageCode, TO),
          eq(explanations.questionNormalized, questionNormalized),
        ),
      );
    await author?.dispose();
    await stranger?.dispose();
  }

  await poolInitialized;
  await closePool();
});

describe('the reader who was served somebody else answer', () => {
  it(
    'sees the answer and no switch at all, because there is nothing for them to grant',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(strangerAskId > 0, 'the stranger must own an ask for this question');

      const request = new Request(`${ORIGIN}/explanations/${strangerAskId}`, {
        headers: { cookie: stranger?.cookie ?? '' },
      });
      const page = await loader(routeArgs(request, strangerAskId));

      assert.equal(page.panel.state, 'ready', 'the stranger must be served the cached answer');
      assert.equal(page.authorship, null, 'a non-author must get no switch, not a disabled one');
    },
  );

  it(
    'cannot turn the byline on, and the stored row does not move',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const result = await submit({ intent: 'show-name', showName: 'true' }, stranger?.cookie ?? '', strangerAskId);

      assert.deepEqual(result, { success: false, error: 'not-author' });
      assert.deepEqual(await storedFlags(), { userId: author?.userId ?? 0, listed: true, showName: false });
    },
  );

  it(
    'cannot do it by posting the real explanation id either, because the id is never read',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const result = await submit(
        { intent: 'show-name', showName: 'true', explanationId },
        stranger?.cookie ?? '',
        strangerAskId,
      );

      assert.deepEqual(result, { success: false, error: 'not-author' });
      assert.deepEqual(await storedFlags(), { userId: author?.userId ?? 0, listed: true, showName: false });
    },
  );

  it(
    'cannot un-list it either, by any of the same routes',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const plain = await submit({ intent: 'listed', listed: 'false' }, stranger?.cookie ?? '', strangerAskId);
      const forged = await submit(
        { intent: 'listed', listed: 'false', explanationId },
        stranger?.cookie ?? '',
        strangerAskId,
      );

      assert.deepEqual(plain, { success: false, error: 'not-author' });
      assert.deepEqual(forged, { success: false, error: 'not-author' });
      assert.equal((await storedFlags())?.listed, true);
    },
  );

  it(
    'cannot reach the row through the author own ask id, which is not theirs to name',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(authorAskId > 0 && authorAskId !== strangerAskId, 'the two asks must be different rows');

      const result = await submit({ intent: 'show-name', showName: 'true' }, stranger?.cookie ?? '', authorAskId);

      // `getExplanationAsk` puts the reader in the WHERE clause, so the author's
      // ask id reads as no row at all for anybody else.
      assert.deepEqual(result, { success: false, error: 'not-author' });
      assert.equal((await storedFlags())?.showName, false);
    },
  );
});

describe('the author of the row', () => {
  it(
    'gets both switches, and their loader carries the row the page resolved',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const request = new Request(`${ORIGIN}/explanations/${authorAskId}`, {
        headers: { cookie: author?.cookie ?? '' },
      });
      const page = await loader(routeArgs(request, authorAskId));

      assert.deepEqual(page.authorship, { explanationId, listed: true, showName: false });
    },
  );

  it(
    'turns the byline on and un-lists the item, and both land',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const shown = await submit({ intent: 'show-name', showName: 'true' }, author?.cookie ?? '', authorAskId);
      assert.deepEqual(shown, { success: true });

      const hidden = await submit({ intent: 'listed', listed: 'false' }, author?.cookie ?? '', authorAskId);
      assert.deepEqual(hidden, { success: true });

      assert.deepEqual(await storedFlags(), { userId: author?.userId ?? 0, listed: false, showName: true });
    },
  );

  it(
    'is refused with no session, and the row does not move',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const body = new FormData();
      body.set('intent', 'listed');
      body.set('listed', 'true');
      const request = new Request(`${ORIGIN}/explanations/${authorAskId}`, { method: 'POST', body });

      assert.deepEqual(await action(routeArgs(request, authorAskId)), {
        success: false,
        error: 'unauthenticated',
      });
      assert.equal((await storedFlags())?.listed, false);
    },
  );
});
