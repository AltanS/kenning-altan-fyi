/**
 * REMOVING A QUESTION TAKES THE READER'S PUBLIC CLAIM WITH IT (M200).
 *
 * THE DEFECT THIS FILE HOLDS SHUT. `removeExplanationAsk` deletes the reader's
 * private log entry and nothing else. Until `withdrawOwnAuthorship` existed, the
 * `explanation_authorship` row survived a remove: still `listed`, still carrying
 * the byline if the reader had turned one on, and now unreachable, because the
 * only page with the switches on it was the ask they had just deleted.
 *
 * WHY IT IS KEYED ON THE QUESTION AND NOT ON AN ANSWERED ROW. Three of the cases
 * below are the whole argument: a `pending` run and a `failed` run must withdraw
 * too, or the claim turns public the moment the run settles, and a reader who
 * authored TWO rows under one key, a failed attempt and the retry that answered
 * it, must lose both.
 *
 * WHAT IT MUST NOT TOUCH. Another reader's claim on the same question, this
 * reader's claim on a different question, and the `explanations` rows
 * themselves, which are the installation's record of runs it paid for. The
 * case that seeds one question under two language pairs is what catches a key
 * widened to `question_normalized` alone.
 *
 * THE LAST TWO CASES DRIVE THE REAL ROUTES, both remove entry points, with real
 * session cookies, the shape `settings-profile-actions.test.ts` established. A
 * helper that withdraws correctly and is called by neither action would pass
 * every case above and fix nothing.
 *
 * NO ORCHESTRATOR AND NO MODEL CALL. Ledger rows are written straight through
 * `insertPendingExplanation` and `settleExplanation`.
 *
 * ISOLATION. Two fixture users and one fresh cache key per case. Every ledger
 * row this file opens is remembered and deleted in `after`, which cascades onto
 * its authorship row; disposing a user cascades onto their asks.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { explanationAsks, explanationAuthorship, explanations } from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { withdrawOwnAuthorship } from '../../app/lib/authorship/withdraw-own-authorship.server';
import type { LanguageCode } from '../../app/lib/dictionary/detect-language';
import { normalizeQuery } from '../../app/lib/dictionary/normalize';
import type { Explanation } from '../../app/lib/llm/explain-schema';
import { recordExplanationAsk } from '../../app/models/explanation-asks.server';
import { insertExplanationAuthorship } from '../../app/models/explanation-authorship.server';
import { insertPendingExplanation, settleExplanation } from '../../app/models/explanations.server';
import { action as detailAction } from '../../app/routes/explanations.$id';
import { action as listAction } from '../../app/routes/explanations';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;
const ORIGIN = 'https://kenning.altan.fyi';

const db = getRawDb();

const FROM = 'de';
const TO = 'en';

/** A run-scoped suffix, so a repeat run of this file writes fresh cache keys. */
const RUN = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;

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

/** Every ledger row this file opened, so `after` can take them all away. */
const openedRows: string[] = [];

/** How many questions this file has invented, so each case gets its own key. */
let asked = 0;

/** One question, as typed and as the cache folds it. */
interface SeededKey {
  question: string;
  questionNormalized: string;
}

/** One question nothing else in this database has asked, and its folded form. */
function freshQuestion(): SeededKey {
  asked += 1;
  const question = `Was bedeutet zzwithdraw${RUN}nr${asked} in diesem Satz?`;
  return { question, questionNormalized: normalizeQuery(question, FROM).normalized };
}

/**
 * Opens one ledger row for a key and settles it, or leaves it `pending`. The
 * row is written for the target `to`, which is `TO` unless a case names another.
 */
async function openRow(params: {
  key: SeededKey;
  status: 'pending' | 'ok' | 'failed';
  to?: LanguageCode;
}): Promise<string> {
  const id = await insertPendingExplanation(db, {
    from: FROM,
    to: params.to ?? TO,
    question: params.key.question,
    questionNormalized: params.key.questionNormalized,
    promptVersion: 2,
    provider: 'openrouter',
    model: 'a-model',
  });
  openedRows.push(id);

  if (params.status === 'ok') await settleExplanation(db, id, { status: 'ok', answer });
  if (params.status === 'failed') await settleExplanation(db, id, { status: 'failed', error: 'written by a test' });
  return id;
}

/**
 * Records one reader's ask for a key and hands back its id. The ask is written
 * for the target `to` and read back for it, `TO` unless a case names another,
 * because one question under two pairs is two ask rows for one reader.
 */
async function recordAsk(params: { userId: number; key: SeededKey; to?: LanguageCode }): Promise<number> {
  const to = params.to ?? TO;
  await recordExplanationAsk({
    userId: params.userId,
    question: params.key.question,
    questionNormalized: params.key.questionNormalized,
    fromLanguage: FROM,
    toLanguage: to,
  });

  const [row] = await db
    .select({ id: explanationAsks.id })
    .from(explanationAsks)
    .where(
      and(
        eq(explanationAsks.userId, params.userId),
        eq(explanationAsks.questionNormalized, params.key.questionNormalized),
        eq(explanationAsks.toLanguage, to),
      ),
    )
    .limit(1);

  if (row === undefined) throw new Error('the ask this case depends on was not recorded');
  return row.id;
}

/** Whether one authorship row is still there. */
async function authorshipExists(explanationId: string): Promise<boolean> {
  const rows = await db
    .select({ explanationId: explanationAuthorship.explanationId })
    .from(explanationAuthorship)
    .where(eq(explanationAuthorship.explanationId, explanationId));
  return rows.length > 0;
}

/** Whether one ledger row is still there. */
async function ledgerRowExists(explanationId: string): Promise<boolean> {
  const rows = await db.select({ id: explanations.id }).from(explanations).where(eq(explanations.id, explanationId));
  return rows.length > 0;
}

/** Whether one ask row is still there. */
async function askExists(askId: number): Promise<boolean> {
  const rows = await db.select({ id: explanationAsks.id }).from(explanationAsks).where(eq(explanationAsks.id, askId));
  return rows.length > 0;
}

/** Every argument the router hands the DETAIL action, for one request. */
function detailArgs(request: Request, askId: number) {
  return {
    request,
    url: new URL(request.url),
    params: { id: String(askId) },
    pattern: '/explanations/:id',
    context: new RouterContextProvider(),
  };
}

/** Every argument the router hands the LIST action, for one request. */
function listArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/explanations',
    context: new RouterContextProvider(),
  };
}

before(async () => {
  if (!DB_HOST) return;

  author = await createTestUserSession('withdraw-author');
  stranger = await createTestUserSession('withdraw-stranger');
});

after(async () => {
  if (DB_HOST) {
    if (openedRows.length > 0) await db.delete(explanations).where(inArray(explanations.id, openedRows));
    await author?.dispose();
    await stranger?.dispose();
  }

  await poolInitialized;
  await closePool();
});

describe('withdrawing the reader own claim on one question', () => {
  it(
    'deletes the authorship row of an answered question and leaves the answer itself',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const key = freshQuestion();
      const explanationId = await openRow({ key, status: 'ok' });
      await insertExplanationAuthorship(db, { explanationId, userId, listed: true });
      const askId = await recordAsk({ userId, key });

      assert.equal(await withdrawOwnAuthorship(db, { userId, askId }), 1);
      assert.equal(await authorshipExists(explanationId), false, 'the claim must go');
      assert.equal(await ledgerRowExists(explanationId), true, 'the paid run must stay');
    },
  );

  it(
    'deletes the claim on a question whose run is still pending',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const key = freshQuestion();
      const explanationId = await openRow({ key, status: 'pending' });
      await insertExplanationAuthorship(db, { explanationId, userId, listed: true });
      const askId = await recordAsk({ userId, key });

      // The whole reason the helper is keyed on the question rather than on a
      // `ready` panel: this row turns public the moment the job settles.
      assert.equal(await withdrawOwnAuthorship(db, { userId, askId }), 1);
      assert.equal(await authorshipExists(explanationId), false);
    },
  );

  it(
    'deletes the claim on a question whose run failed',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const key = freshQuestion();
      const explanationId = await openRow({ key, status: 'failed' });
      await insertExplanationAuthorship(db, { explanationId, userId, listed: true });
      const askId = await recordAsk({ userId, key });

      assert.equal(await withdrawOwnAuthorship(db, { userId, askId }), 1);
      assert.equal(await authorshipExists(explanationId), false);
    },
  );

  it(
    'deletes both claims when one reader authored two attempts at the same question',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const key = freshQuestion();
      const firstAttempt = await openRow({ key, status: 'failed' });
      const retry = await openRow({ key, status: 'ok' });
      await insertExplanationAuthorship(db, { explanationId: firstAttempt, userId, listed: true });
      await insertExplanationAuthorship(db, { explanationId: retry, userId, listed: true });
      const askId = await recordAsk({ userId, key });

      assert.equal(await withdrawOwnAuthorship(db, { userId, askId }), 2);
      assert.equal(await authorshipExists(firstAttempt), false);
      assert.equal(await authorshipExists(retry), false);
    },
  );
});

describe('withdrawing leaves everything that is not this reader own claim', () => {
  it(
    'does not touch another reader claim on the same question',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const otherId = stranger?.userId ?? 0;
      const key = freshQuestion();
      const mine = await openRow({ key, status: 'ok' });
      const theirs = await openRow({ key, status: 'ok' });
      await insertExplanationAuthorship(db, { explanationId: mine, userId, listed: true });
      await insertExplanationAuthorship(db, { explanationId: theirs, userId: otherId, listed: true });
      const askId = await recordAsk({ userId, key });

      assert.equal(await withdrawOwnAuthorship(db, { userId, askId }), 1);
      assert.equal(await authorshipExists(mine), false);
      assert.equal(await authorshipExists(theirs), true, 'the other reader claim is not this caller to drop');
    },
  );

  it(
    'does not touch this reader claim on a different question',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const removed = freshQuestion();
      const kept = freshQuestion();
      const removedRow = await openRow({ key: removed, status: 'ok' });
      const keptRow = await openRow({ key: kept, status: 'ok' });
      await insertExplanationAuthorship(db, { explanationId: removedRow, userId, listed: true });
      await insertExplanationAuthorship(db, { explanationId: keptRow, userId, listed: true });
      const askId = await recordAsk({ userId, key: removed });
      await recordAsk({ userId, key: kept });

      assert.equal(await withdrawOwnAuthorship(db, { userId, askId }), 1);
      assert.equal(await authorshipExists(removedRow), false);
      assert.equal(await authorshipExists(keptRow), true, 'only the withdrawn question key may be matched');
    },
  );

  it(
    'does not touch this reader claim on the same question under another language pair',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const key = freshQuestion();
      const englishRow = await openRow({ key, status: 'ok' });
      const spanishRow = await openRow({ key, status: 'ok', to: 'es' });
      await insertExplanationAuthorship(db, { explanationId: englishRow, userId, listed: true });
      await insertExplanationAuthorship(db, { explanationId: spanishRow, userId, listed: true });
      const englishAskId = await recordAsk({ userId, key });
      await recordAsk({ userId, key, to: 'es' });

      // The key is the whole triple. A helper widened to `question_normalized`
      // alone would take the Spanish claim down with the English one.
      assert.equal(await withdrawOwnAuthorship(db, { userId, askId: englishAskId }), 1);
      assert.equal(await authorshipExists(englishRow), false, 'the withdrawn pair claim must go');
      assert.equal(await authorshipExists(spanishRow), true, 'the same question under another pair is another key');

      // The premise, read back and not assumed: two paid runs, one folded question.
      const ledger = await db
        .select({ questionNormalized: explanations.questionNormalized })
        .from(explanations)
        .where(inArray(explanations.id, [englishRow, spanishRow]));
      assert.equal(ledger.length, 2, 'the paid runs must stay');
      assert.deepEqual([...new Set(ledger.map((row) => row.questionNormalized))], [key.questionNormalized]);
    },
  );

  it(
    'withdraws nothing for an ask id that never existed',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const key = freshQuestion();
      const explanationId = await openRow({ key, status: 'ok' });
      await insertExplanationAuthorship(db, { explanationId, userId, listed: true });
      const askId = await recordAsk({ userId, key });

      assert.equal(await withdrawOwnAuthorship(db, { userId, askId: askId + 10_000_000 }), 0);
      assert.equal(await authorshipExists(explanationId), true);
    },
  );

  it(
    'withdraws nothing when the ask id belongs to another account',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const otherId = stranger?.userId ?? 0;
      const key = freshQuestion();
      const explanationId = await openRow({ key, status: 'ok' });
      await insertExplanationAuthorship(db, { explanationId, userId, listed: true });
      const askId = await recordAsk({ userId, key });

      // `getExplanationAsk` puts the reader in the WHERE clause, so the author's
      // own ask id reads as no row at all for anybody else.
      assert.equal(await withdrawOwnAuthorship(db, { userId: otherId, askId }), 0);
      assert.equal(await authorshipExists(explanationId), true);
    },
  );
});

describe('both remove entry points withdraw before they delete the ask', () => {
  it(
    'the detail page REMOVE intent leaves neither the claim nor the ask',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const key = freshQuestion();
      const explanationId = await openRow({ key, status: 'ok' });
      await insertExplanationAuthorship(db, { explanationId, userId, listed: true });
      const askId = await recordAsk({ userId, key });

      const body = new FormData();
      body.set('intent', 'remove');
      const headers = new Headers();
      headers.set('cookie', author?.cookie ?? '');
      const request = new Request(`${ORIGIN}/explanations/${askId}`, { method: 'POST', headers, body });

      const result = await detailAction(detailArgs(request, askId));

      assert.deepEqual(result, { success: true });
      assert.equal(await authorshipExists(explanationId), false, 'the claim must go with the ask');
      assert.equal(await askExists(askId), false);
      assert.equal(await ledgerRowExists(explanationId), true, 'the paid run must stay');
    },
  );

  it(
    'the list row remove leaves neither the claim nor the ask',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = author?.userId ?? 0;
      const key = freshQuestion();
      const explanationId = await openRow({ key, status: 'ok' });
      await insertExplanationAuthorship(db, { explanationId, userId, listed: true });
      const askId = await recordAsk({ userId, key });

      const body = new FormData();
      body.set('intent', 'remove');
      body.set('id', String(askId));
      const headers = new Headers();
      headers.set('cookie', author?.cookie ?? '');
      const request = new Request(`${ORIGIN}/explanations`, { method: 'POST', headers, body });

      const result = await listAction(listArgs(request));

      assert.deepEqual(result, { success: true });
      assert.equal(await authorshipExists(explanationId), false, 'the claim must go with the ask');
      assert.equal(await askExists(askId), false);
      assert.equal(await ledgerRowExists(explanationId), true, 'the paid run must stay');
    },
  );
});
