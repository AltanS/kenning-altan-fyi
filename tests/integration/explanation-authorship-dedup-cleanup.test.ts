/**
 * A DEDUPED ENQUEUE LEAVES NO AUTHORSHIP ROW BEHIND (M200).
 *
 * WHAT THIS FILE HOLDS IN PLACE. `enqueueExplain` opens a ledger row and its
 * authorship row BEFORE it discovers whether this call wins the singleton key.
 * The loser deletes the ledger row it opened, and
 * `explanation_authorship.explanation_id` cascades off it, so the losing
 * reader's claim goes with it and no code in the dedupe path knows the table
 * exists. That is a claim about a foreign key, which only a real database can
 * answer. A missing `onDelete: 'cascade'` would show up here either as a second
 * authorship row for a row that no longer exists or as a failing delete.
 *
 * TWO DIFFERENT READERS ASKING ONE QUESTION, which is the case that matters:
 * the second reader must end up with nothing, not with a claim on the first
 * reader's row. A single reader asking twice would prove less.
 *
 * THE ORCHESTRATOR IS INITIALISED AND NO WORKER IS EVER STARTED, so the first
 * ask's job is still open on the queue when the second ask races it.
 *
 * ISOLATION. One run-scoped question, two fixture users, all taken away in
 * `after`.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, count, eq, inArray, sql } from 'drizzle-orm';

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
const question = `Was bedeutet zzdedupcleanup${RUN} eigentlich?`;
const questionNormalized = normalizeQuery(question, FROM).normalized;

const singletonKey = explainSingletonKey({
  from: FROM,
  to: TO,
  questionNormalized,
  promptVersion: EXPLAIN_PROMPT_VERSION,
  runId: 'unused-the-key-drops-it',
});

const createdCounterKeys: string[] = [];

let sessionA: TestUserSession | null = null;
let sessionB: TestUserSession | null = null;

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

/** A fresh request for this key, with its own address, so the rate limiter never turns either ask away. */
function freshRequest(): Request {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  return new Request(`https://kenning.altan.fyi/explain?q=${encodeURIComponent(question)}&from=${FROM}&to=${TO}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

/** How many authorship rows one reader holds, across the whole table. */
async function authorshipCountFor(userId: number): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(explanationAuthorship)
    .where(eq(explanationAuthorship.userId, userId));
  return row?.total ?? 0;
}

before(async () => {
  if (!DB_HOST) return;
  await initializeWorkflows();
  sessionA = await createTestUserSession('authorship-dedup-winner');
  sessionB = await createTestUserSession('authorship-dedup-loser');
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
  await sessionA?.dispose();
  await sessionB?.dispose();

  await poolInitialized;
  await closePool();
});

describe('the reader who lost the singleton key', () => {
  it(
    'leaves one ledger row, one authorship row, and that row names the winner',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const winner = sessionA?.userId ?? 0;
      const loser = sessionB?.userId ?? 0;
      assert.ok(winner > 0 && loser > 0, 'both fixture users must exist before either ask');

      const first = await resolveTriggeredExplainPanel(db, {
        request: freshRequest(),
        question,
        questionNormalized,
        from: FROM,
        to: TO,
        userId: winner,
      });
      if (first.state !== 'translating' || first.queuedRunId === null) {
        assert.fail(`expected the first ask to queue a fresh run, got ${JSON.stringify(first)}`);
      }
      const runId = first.queuedRunId;

      // THE SECOND ASK, BEFORE THE FIRST SETTLES. No worker has ever run, so the
      // first ask's job is still open and this one takes the `deduped` branch:
      // it opens its own ledger row, discovers the duplicate, and deletes it.
      const second = await resolveTriggeredExplainPanel(db, {
        request: freshRequest(),
        question,
        questionNormalized,
        from: FROM,
        to: TO,
        userId: loser,
      });
      assert.deepEqual(second, { state: 'translating', queuedRunId: null });

      const ledgerRows = await db
        .select({ id: explanations.id })
        .from(explanations)
        .where(
          and(
            eq(explanations.fromLanguageCode, FROM),
            eq(explanations.toLanguageCode, TO),
            eq(explanations.questionNormalized, questionNormalized),
          ),
        );
      assert.deepEqual(ledgerRows, [{ id: runId }], 'the losing ask left a second row for this key');

      const authorRows = await db
        .select({ explanationId: explanationAuthorship.explanationId, userId: explanationAuthorship.userId })
        .from(explanationAuthorship)
        .where(inArray(explanationAuthorship.userId, [winner, loser]));
      assert.deepEqual(
        authorRows,
        [{ explanationId: runId, userId: winner }],
        'the surviving authorship row must belong to the winner, and the loser must hold none',
      );
    },
  );

  it(
    'holds no authorship row anywhere, so nothing was left for a later screen to find',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const loser = sessionB?.userId ?? 0;
      assert.ok(loser > 0, 'the second fixture user must exist');
      assert.equal(await authorshipCountFor(loser), 0);
    },
  );
});
