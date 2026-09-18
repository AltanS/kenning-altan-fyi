/**
 * ONE FRESH QUESTION OPENS ONE LEDGER ROW AND ONE AUTHORSHIP ROW, COMMITTED
 * TOGETHER (M200).
 *
 * WHAT THIS FILE HOLDS IN PLACE. `enqueueExplain` wraps `insertPendingExplanation`
 * and `insertExplanationAuthorship` in one `db.transaction`, so there is no
 * window in which an explanation exists with nobody attached to it. The unit
 * tier proves the two writes share a handle; only a real database can prove the
 * pair actually lands, under real foreign keys, through the real resolver.
 *
 * IT DRIVES THE RESOLVER, NOT A ROUTE, exactly as
 * `explain-enqueue-result.test.ts` does and for the same reason: the claim is
 * about `resolveTriggeredExplainPanel` and the enqueue under it, and a route
 * would only add an auth gate this change does not touch.
 *
 * THE ORCHESTRATOR IS INITIALISED AND NO WORKER IS EVER STARTED, so the row
 * stays `pending` for as long as the assertions need it.
 *
 * ISOLATION. One run-scoped question, one fixture user, and both taken away in
 * `after`. Deleting the user cascades onto the authorship row; the ledger rows
 * for the key are deleted by key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { abuseCounters, explanationAuthorship, explanations, workflows } from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { normalizeQuery } from '../../app/lib/dictionary/normalize';
import { resolveTriggeredExplainPanel } from '../../app/lib/translation/explain-panel.server';
import { explainSingletonKey } from '../../app/lib/translation/explain-job-payload';
import { EXPLAIN_QUEUE } from '../../app/lib/translation/limits';
import { EXPLAIN_PROMPT_VERSION } from '../../app/prompts/explain/version';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'de';
const TO = 'en';

/** A run-scoped suffix, so a repeat run of this file opens a fresh cache key. */
const RUN = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;
const question = `Was bedeutet zzauthorshipwrite${RUN} im Alltag?`;
const questionNormalized = normalizeQuery(question, FROM).normalized;

const singletonKey = explainSingletonKey({
  from: FROM,
  to: TO,
  questionNormalized,
  promptVersion: EXPLAIN_PROMPT_VERSION,
  runId: 'unused-the-key-drops-it',
});

const createdCounterKeys: string[] = [];

let session: TestUserSession | null = null;

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

/** A fresh request for this key, with its own address, so the rate limiter never turns the ask away. */
function freshRequest(): Request {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  return new Request(`https://kenning.altan.fyi/explain?q=${encodeURIComponent(question)}&from=${FROM}&to=${TO}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

before(async () => {
  if (!DB_HOST) return;
  await initializeWorkflows();
  session = await createTestUserSession('authorship-write');
});

after(async () => {
  if (!DB_HOST) {
    await closePool();
    return;
  }

  await stopOrchestrator();
  await db.execute(sql`delete from pgboss.job where name = ${EXPLAIN_QUEUE} and singleton_key = ${singletonKey}`);
  await db.delete(workflows).where(sql`${workflows.context}->>'questionNormalized' = ${questionNormalized}`);
  await db
    .delete(explanations)
    .where(
      and(
        eq(explanations.fromLanguageCode, FROM),
        eq(explanations.toLanguageCode, TO),
        eq(explanations.questionNormalized, questionNormalized),
      ),
    );
  if (createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }
  await session?.dispose();

  await poolInitialized;
  await closePool();
});

describe('the ledger row and the row naming its author', () => {
  it(
    'both exist after one ask, and the authorship row names the reader who asked',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = session?.userId ?? 0;
      assert.ok(userId > 0, 'the fixture user must exist before the ask');

      const panel = await resolveTriggeredExplainPanel(db, {
        request: freshRequest(),
        question,
        questionNormalized,
        from: FROM,
        to: TO,
        userId,
      });
      if (panel.state !== 'translating') {
        assert.fail(`expected the ask to queue a fresh run, got ${JSON.stringify(panel)}`);
      }
      const runId = panel.queuedRunId;
      assert.ok(runId !== null, 'the ask must report the id of the row it caused to be queued');

      const [ledgerRow] = await db
        .select({ id: explanations.id, status: explanations.status })
        .from(explanations)
        .where(eq(explanations.id, runId));
      assert.equal(ledgerRow?.status, 'pending');

      const [authorRow] = await db
        .select({
          userId: explanationAuthorship.userId,
          listed: explanationAuthorship.listed,
          showName: explanationAuthorship.showName,
        })
        .from(explanationAuthorship)
        .where(eq(explanationAuthorship.explanationId, runId));

      assert.deepEqual(
        authorRow,
        { userId, listed: true, showName: false },
        'the ledger row committed with no author beside it',
      );
    },
  );

  it(
    'leaves no row for this key without an author, which is what one transaction buys',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const orphans = await db
        .select({ id: explanations.id })
        .from(explanations)
        .leftJoin(explanationAuthorship, eq(explanationAuthorship.explanationId, explanations.id))
        .where(
          and(
            eq(explanations.fromLanguageCode, FROM),
            eq(explanations.toLanguageCode, TO),
            eq(explanations.questionNormalized, questionNormalized),
            sql`${explanationAuthorship.explanationId} is null`,
          ),
        );

      assert.deepEqual(orphans, [], 'an explanation for this key exists with nobody attached to it');
    },
  );
});
