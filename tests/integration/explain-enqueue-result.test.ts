/**
 * ONE FRESH QUESTION, ASKED TWICE BEFORE IT SETTLES, MUST TELL THE TWO ASKS
 * APART.
 *
 * `enqueueExplain` already answers a three-way `ExplainEnqueueResult`
 * (`queued`, `deduped`, `unavailable`) and mints a real `explanations` row id
 * on the winning `queued` outcome, all backed by the `explain-terms` queue's
 * `stately` policy. Until this fix, `resolveTriggeredExplainPanel` reported
 * `{ state: 'translating' }` for BOTH `queued` and `deduped`, discarding the
 * id every time. This file proves the panel now tells the two asks apart.
 *
 * THIS FILE DRIVES THE RESOLVER DIRECTLY, NOT A ROUTE. The claim under test is
 * about `resolveTriggeredExplainPanel` itself, the entry point both
 * `explain.tsx`'s loader and `api.explain.retry.ts`'s action call. Going
 * through either route would add an auth gate this fix does not touch and
 * would prove nothing extra about it.
 *
 * THE ORCHESTRATOR IS INITIALISED, AND THE WORKER IS NEVER STARTED, for the
 * same reason `translation-enqueue-dedupe.test.ts` never starts one: polling
 * only begins from `orchestrator.startWorker()`. The first call's row therefore
 * stays `pending` for as long as this file needs it to, and the second call's
 * `enqueueExplain` genuinely races the still-open singleton key rather than an
 * already-finished job.
 *
 * ISOLATION. One question carrying a run-scoped suffix, so a repeat run of
 * this file never collides with a previous run's leftover row. Every request
 * carries a fresh documentation-range address, and its rate-limit counter is
 * deleted by key in `after`.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { abuseCounters, explanations, workflows } from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { normalizeQuery } from '../../app/lib/dictionary/normalize';
import { resolveTriggeredExplainPanel } from '../../app/lib/translation/explain-panel.server';
import { explainSingletonKey } from '../../app/lib/translation/explain-job-payload';
import { EXPLAIN_QUEUE } from '../../app/lib/translation/limits';
import { EXPLAIN_PROMPT_VERSION } from '../../app/prompts/explain/version';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'de';
const TO = 'en';

/** A run-scoped suffix, so a repeat run of this file opens a fresh cache key. */
const RUN = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;
const question = `Was ist der Unterschied zwischen kennen und wissen, zzexplainresult${RUN}?`;
const questionNormalized = normalizeQuery(question, FROM).normalized;

const singletonKey = explainSingletonKey({
  from: FROM,
  to: TO,
  questionNormalized,
  promptVersion: EXPLAIN_PROMPT_VERSION,
  runId: 'unused-the-key-drops-it',
});

const createdCounterKeys: string[] = [];

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

/** Every row that exists for this key, whatever its status. */
async function rowsForKey() {
  return db
    .select({ id: explanations.id, status: explanations.status })
    .from(explanations)
    .where(
      and(
        eq(explanations.fromLanguageCode, FROM),
        eq(explanations.toLanguageCode, TO),
        eq(explanations.questionNormalized, questionNormalized),
      ),
    );
}

before(async () => {
  if (!DB_HOST) return;
  // The honest path: this registers the templates, so `enqueueExplain`'s
  // `orchestrator.start()` can resolve `explain-terms` and reach `boss.send`.
  await initializeWorkflows();
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

  await poolInitialized;
  await closePool();
});

describe('the explain enqueue result, carried through the panel', () => {
  it(
    'mints a row id for the first ask, and answers no id for the second ask of the same key, before either settles',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const first = await resolveTriggeredExplainPanel(db, {
        request: freshRequest(),
        question,
        questionNormalized,
        from: FROM,
        to: TO,
      });
      if (first.state !== 'translating') {
        assert.fail(`expected the first ask to queue a fresh run, got ${JSON.stringify(first)}`);
      }
      assert.ok(
        first.queuedRunId !== null && first.queuedRunId.length > 0,
        'the first ask must report the id of the row IT caused to be queued',
      );
      const firstRunId = first.queuedRunId;

      // THE SECOND ASK, BEFORE THE FIRST SETTLES. No worker has ever run, so the
      // first run's job is still open on the queue and this ask must be the
      // `deduped` branch of `enqueueExplain`, riding the first ask's row rather
      // than opening its own.
      const second = await resolveTriggeredExplainPanel(db, {
        request: freshRequest(),
        question,
        questionNormalized,
        from: FROM,
        to: TO,
      });
      if (second.state !== 'translating') {
        assert.fail(`expected the second ask to be translating too, got ${JSON.stringify(second)}`);
      }
      assert.equal(
        second.queuedRunId,
        null,
        'the second ask only observed a run already open, so it must report no id of its own',
      );

      const rows = await rowsForKey();
      assert.equal(
        rows.length,
        1,
        `expected exactly one surviving row for this key, found ${rows.length}. A deduped enqueue must delete the ` +
          'row it opened before it discovered the duplicate, or the pane would read two rows for one key.',
      );
      assert.equal(rows[0]?.id, firstRunId, "the surviving row is not the one the first ask's queuedRunId named");
      assert.equal(rows[0]?.status, 'pending');
    },
  );
});
