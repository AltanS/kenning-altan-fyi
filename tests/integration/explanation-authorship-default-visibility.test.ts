/**
 * THE INITIAL VISIBILITY OF A FRESH EXPLANATION COMES FROM THE ASKER'S OWN
 * STANDING PREFERENCE (M200), never from anything on the request.
 *
 * WHAT THIS FILE HOLDS IN PLACE. M199 stored
 * `user_profiles.hide_new_explanations_by_default` and enforced it nowhere: its
 * own settings copy said so in as many words. This is the file that makes the
 * column load-bearing. Reader A turns it on and the row their question opens is
 * written `listed = false`; reader B has no profile row at all, which is the
 * all-defaults shape, and theirs is written `listed = true`.
 *
 * TWO DIFFERENT QUESTIONS, AND THAT IS NOT INCIDENTAL. The two readers must not
 * share a cache key, or the second ask would dedupe onto the first reader's
 * still-open run and open no row of its own, and the case would pass while
 * asserting nothing about B.
 *
 * THE ORCHESTRATOR IS INITIALISED AND NO WORKER IS EVER STARTED.
 *
 * ISOLATION. Two run-scoped questions, two fixture users, all taken away in
 * `after`. Disposing a user cascades onto their profile row and their authorship
 * rows.
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
import { setHideNewExplanationsByDefault } from '../../app/models/user-profiles.server';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'de';
const TO = 'en';

/** A run-scoped suffix, so a repeat run of this file opens two fresh cache keys. */
const RUN = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;

/** One reader's question, folded the way the ledger folds it. */
function keyFor(suffix: string) {
  const question = `Was bedeutet zzvisibility${suffix}${RUN} genau?`;
  const questionNormalized = normalizeQuery(question, FROM).normalized;
  return { question, questionNormalized };
}

const hidden = keyFor('hidden');
const listed = keyFor('listed');

const createdCounterKeys: string[] = [];

let sessionA: TestUserSession | null = null;
let sessionB: TestUserSession | null = null;

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

/** A fresh request for one key, with its own address, so the rate limiter never turns an ask away. */
function freshRequest(question: string): Request {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  return new Request(`https://kenning.altan.fyi/explain?q=${encodeURIComponent(question)}&from=${FROM}&to=${TO}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

/** The authorship row one ask opened, read back by the ledger id the panel reported. */
async function authorshipFor(explanationId: string) {
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

/** One ask, and the id of the row it opened. */
async function ask(question: string, questionNormalized: string, userId: number): Promise<string> {
  const panel = await resolveTriggeredExplainPanel(db, {
    request: freshRequest(question),
    question,
    questionNormalized,
    from: FROM,
    to: TO,
    userId,
  });
  if (panel.state !== 'translating' || panel.queuedRunId === null) {
    assert.fail(`expected a fresh run to be queued, got ${JSON.stringify(panel)}`);
  }
  return panel.queuedRunId;
}

before(async () => {
  if (!DB_HOST) return;
  await initializeWorkflows();
  sessionA = await createTestUserSession('authorship-hidden');
  sessionB = await createTestUserSession('authorship-listed');
});

after(async () => {
  if (!DB_HOST) {
    await closePool();
    return;
  }

  await stopOrchestrator();
  for (const key of [hidden, listed]) {
    const singletonKey = explainSingletonKey({
      from: FROM,
      to: TO,
      questionNormalized: key.questionNormalized,
      promptVersion: EXPLAIN_PROMPT_VERSION,
      runId: 'unused-the-key-drops-it',
    });
    await db.execute(sql`delete from pgboss.job where name = ${EXPLAIN_QUEUE} and singleton_key = ${singletonKey}`);
    await db.delete(workflows).where(sql`${workflows.context}->>'questionNormalized' = ${key.questionNormalized}`);
    await db
      .delete(explanations)
      .where(
        and(
          eq(explanations.fromLanguageCode, FROM),
          eq(explanations.toLanguageCode, TO),
          eq(explanations.questionNormalized, key.questionNormalized),
        ),
      );
  }
  if (createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }
  await sessionA?.dispose();
  await sessionB?.dispose();

  await poolInitialized;
  await closePool();
});

describe('the preference decides what a fresh explanation starts as', () => {
  it('a reader who asked for hidden gets an unlisted row', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = sessionA?.userId ?? 0;
    assert.ok(userId > 0, 'the first fixture user must exist');

    await setHideNewExplanationsByDefault(db, { userId, hide: true });
    const explanationId = await ask(hidden.question, hidden.questionNormalized, userId);

    assert.deepEqual(await authorshipFor(explanationId), { userId, listed: false, showName: false });
  });

  it(
    'a reader with no profile row at all gets a listed row',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = sessionB?.userId ?? 0;
      assert.ok(userId > 0, 'the second fixture user must exist');

      const explanationId = await ask(listed.question, listed.questionNormalized, userId);

      assert.deepEqual(await authorshipFor(explanationId), { userId, listed: true, showName: false });
    },
  );
});
