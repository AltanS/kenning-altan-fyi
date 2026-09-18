/**
 * `setShowName` AND `setListed` REFUSE A USER ID THAT IS NOT THE ROW'S (M200).
 *
 * WHY THIS FILE EXISTS AT ALL, GIVEN THE OWNERSHIP FILE BESIDE IT. Every
 * non-author request is already stopped one layer up, by `resolveOwnAuthorship`,
 * and `explanation-authorship-ownership.test.ts` proves that through the real
 * route. So the second, defence-in-depth check inside the two setters, the
 * `eq(explanationAuthorship.userId, ...)` clause in each `WHERE`, was covered by
 * nothing: deleting it left the whole suite green. A guard no test can fail is a
 * guard the next refactor removes as dead weight.
 *
 * SO THESE CASES CALL THE MODEL DIRECTLY, ON PURPOSE. Driving the route would
 * re-test the layer above and reach these clauses with the right id every time.
 * The claim here is narrower and lower: given a row and a user id that does not
 * own it, each setter writes nothing and says so.
 *
 * THE ORDER OF THE TWO CASES PER SETTER MATTERS. The wrong id is tried first,
 * against a known starting value; the right id follows and moves it. A setter
 * that ignored its user id would pass the second case and fail the first.
 *
 * ISOLATION. One ledger row, one authorship row, two fixture users. The ledger
 * row is deleted in `after`, which cascades onto the authorship row.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { explanationAuthorship, explanations } from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { normalizeQuery } from '../../app/lib/dictionary/normalize';
import type { Explanation } from '../../app/lib/llm/explain-schema';
import {
  insertExplanationAuthorship,
  setListed,
  setShowName,
} from '../../app/models/explanation-authorship.server';
import { insertPendingExplanation, settleExplanation } from '../../app/models/explanations.server';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'de';
const TO = 'en';

/** A run-scoped suffix, so a repeat run of this file writes a fresh cache key. */
const RUN = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;
const question = `Was bedeutet zzsetters${RUN} in diesem Satz?`;
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

/** The two flags, read straight off the table. */
async function storedFlags(): Promise<{ listed: boolean; showName: boolean } | null> {
  const [row] = await db
    .select({ listed: explanationAuthorship.listed, showName: explanationAuthorship.showName })
    .from(explanationAuthorship)
    .where(eq(explanationAuthorship.explanationId, explanationId));
  return row ?? null;
}

before(async () => {
  if (!DB_HOST) return;

  author = await createTestUserSession('setters-author');
  stranger = await createTestUserSession('setters-stranger');

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
});

after(async () => {
  if (DB_HOST) {
    if (explanationId !== '') await db.delete(explanations).where(eq(explanations.id, explanationId));
    await author?.dispose();
    await stranger?.dispose();
  }

  await poolInitialized;
  await closePool();
});

describe('setShowName', () => {
  it(
    'writes nothing and answers false for a user id that does not own the row',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const written = await setShowName(db, {
        explanationId,
        userId: stranger?.userId ?? 0,
        showName: true,
      });

      assert.equal(written, false, 'a wrong user id must write nothing');
      assert.deepEqual(await storedFlags(), { listed: true, showName: false });
    },
  );

  it(
    'writes and answers true for the row own author',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const written = await setShowName(db, { explanationId, userId: author?.userId ?? 0, showName: true });

      assert.equal(written, true);
      assert.deepEqual(await storedFlags(), { listed: true, showName: true });
    },
  );
});

describe('setListed', () => {
  it(
    'writes nothing and answers false for a user id that does not own the row',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const written = await setListed(db, { explanationId, userId: stranger?.userId ?? 0, listed: false });

      assert.equal(written, false, 'a wrong user id must write nothing');
      assert.deepEqual(await storedFlags(), { listed: true, showName: true });
    },
  );

  it(
    'writes and answers true for the row own author',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const written = await setListed(db, { explanationId, userId: author?.userId ?? 0, listed: false });

      assert.equal(written, true);
      assert.deepEqual(await storedFlags(), { listed: false, showName: true });
    },
  );
});
