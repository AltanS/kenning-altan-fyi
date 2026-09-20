/**
 * Rejecting one generated translation, driven through the real route.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `POST /api/translation/:headwordId/reject` is the one control that both
 *   records a reader's judgement AND may order a paid model call because of it.
 *   Four things can go wrong in ways nothing else notices, and each is a case
 *   below.
 *
 *   1. THE COOLDOWN MUST WITHHOLD THE SPEND AND NEVER THE SIGNAL. A rejection
 *      inside the window is still recorded in full. If it were swallowed, the
 *      second and third reader to complain about one bad answer would leave no
 *      trace, and the tally that triages bad answers would under-count exactly
 *      the answers most people disagree with.
 *   2. ONE READER, ONE COMPLAINT. The composite primary key on
 *      (runId, accountId) is the rule, and `recordRejection` reports back
 *      whether the row was new. A second press must add no signal row, because
 *      a tally that counted one reader twice would read as two people agreeing,
 *      and must buy no second model call.
 *   3. THERE HAS TO BE A MODEL ANSWER TO REJECT. A pair whose latest run is not
 *      `ok` answers `no-run` and writes nothing: an answer assembled from
 *      imported edges has no run behind it, and a complaint naming no model
 *      output is worthless to the corpus it feeds.
 *   4. A REFUSED RE-RUN MUST NOT STAMP THE COOLDOWN. Stamping on a budget
 *      refusal would lock the headword out for a day in exchange for a run that
 *      never happened, and every later rejection of the same answer would be
 *      declined a re-run because of an outage no reader can see.
 *
 * A QUEUED RE-RUN SUPERSEDES THE RUN IT WAS ORDERED BY, AND THAT IS WHY THE
 * CASES BELOW USE TWO ANSWERED PAIRS RATHER THAN ONE.
 *   `enqueueTranslation` opens a NEW `pending` row for the same
 *   `(headword, direction)` key, and `latestRun` reads the newest row, so the
 *   moment a rejection orders a re-run the pair's latest run is no longer `ok`
 *   and the route answers `no-run` to the next press. That is the correct
 *   product answer, not a defect: while the re-run is in flight the pane reads
 *   `translating`, there is no answer on screen, and there is nothing to
 *   reject. A repeat press and a second reader therefore have to be driven
 *   against a pair whose re-run was WITHHELD, which is what the pre-stamped
 *   cooldown below arranges.
 *
 * THE ORCHESTRATOR IS INITIALISED, AND THE WORKER IS NEVER STARTED. A genuine
 * `queued` outcome needs a reachable queue, and `initializeWorkflows()` alone
 * gives one: polling only begins from `orchestrator.startWorker()`, which this
 * file never calls, so no model is ever asked anything.
 *
 * THE BUDGET ROW IS WRITTEN TO THE CAP BY THE LAST CASE ONLY, so the earlier
 * cases run against a healthy installation. `setUpTranslationFixture`
 * photographs today's figures before anything here changes them, and
 * `tearDownTranslationFixture` writes them back.
 *
 * ISOLATION. Four headwords with a run-scoped suffix, removed through
 * `tearDownTranslationFixture`, which also removes their runs; the rejection
 * and signal rows cascade off those runs. The `retranslation_log` rows do NOT
 * cascade, so they are deleted by key. Every request carries a fresh
 * documentation-range address, and its rate-limit counter is deleted by key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';
import { z } from 'zod';

import {
  abuseCounters,
  dailyBudget,
  retranslationLog,
  translationRejectionSignals,
  translationRejections,
  translationRuns,
  workflows,
} from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { DAILY_BUDGET_USD, utcDay } from '../../app/lib/abuse/budget.server';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { createPendingRun, finishRun } from '../../app/models/translation-runs.server';
import { touchRetranslationCooldown } from '../../app/models/translation-rejections.server';
import { TRANSLATION_QUEUE } from '../../app/lib/translation/limits';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
import { action as rejectTranslation } from '../../app/routes/api.translation.$headwordId.reject';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { createFakeLlmPort } from '../fixtures/fake-llm-port';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';
import {
  seedHeadword,
  setUpTranslationFixture,
  tearDownTranslationFixture,
  type TranslationFixture,
} from '../fixtures/translation-corpus';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'de';
const TO = 'tr';

/** A provider and model name for a run row nothing in this file ever executes. */
const STUB_PROVIDER = 'stub-provider';
const STUB_MODEL = 'stub-model';

let fixture: TranslationFixture = {
  sourceId: '',
  generatedSourceId: '',
  fake: createFakeLlmPort(),
  run: '',
  seededHeadwordIds: [],
};
let session: TestUserSession | null = null;
let secondSession: TestUserSession | null = null;

/** The pair with a finished `ok` run, which every happy-path case rejects. */
let answeredHeadwordId = '';
let answeredRunId = '';
/**
 * A second pair with a finished `ok` run, and a cooldown cursor already stamped.
 *
 * ITS RE-RUN IS WITHHELD BY CONSTRUCTION, which is the whole reason it exists:
 * nothing queues a job against it, so its latest run stays `ok` and a repeat
 * press and a second reader can both be driven against a real answer.
 */
let cooldownHeadwordId = '';
let cooldownRunId = '';
/** A pair whose latest run FAILED, so there is nothing on screen to have been wrong. */
let failedHeadwordId = '';
/** A pair rejected once the day's budget is at its cap. */
let refusedHeadwordId = '';

const createdCounterKeys: string[] = [];

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

function freshIp(): string {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  return ip;
}

/**
 * The response body, decoded rather than trusted.
 *
 * A test that read `body.state` off an untyped value would keep passing if the
 * field were renamed, which is the one change this file exists to catch.
 */
const rejectResponseSchema = z.object({
  state: z.string(),
  rerun: z.string().optional(),
  panel: z.object({ state: z.string() }).nullable().optional(),
  messageKey: z.string().optional(),
});

/** `POST /api/translation/:headwordId/reject?to=tr`, exactly as the pane posts it. */
async function reject(params: {
  headwordId: string;
  reason: string;
  cookie: string | null;
}): Promise<{ status: number; body: z.infer<typeof rejectResponseSchema> }> {
  const body = new FormData();
  body.set('reason', params.reason);

  const headers = new Headers({ 'x-forwarded-for': freshIp() });
  if (params.cookie !== null) headers.set('cookie', params.cookie);

  const request = new Request(
    `https://kenning.altan.fyi/api/translation/${params.headwordId}/reject?to=${TO}`,
    { method: 'POST', headers, body },
  );
  const response = await rejectTranslation({
    request,
    url: new URL(request.url),
    params: { headwordId: params.headwordId },
    pattern: '/api/translation/:headwordId/reject',
    context: new RouterContextProvider(),
  });
  return { status: response.status, body: rejectResponseSchema.parse(await response.json()) };
}

/** How many FACT rows one run carries: one per reader who rejected it. */
async function countFacts(runId: string): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(translationRejections)
    .where(eq(translationRejections.runId, runId));
  return rows[0]?.value ?? 0;
}

/** How many SIGNAL rows one run carries: the tally an operator triages on. */
async function countSignals(runId: string): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(translationRejectionSignals)
    .where(eq(translationRejectionSignals.runId, runId));
  return rows[0]?.value ?? 0;
}

/** Whether a cooldown cursor exists for one pair. */
async function hasCooldown(headwordId: string): Promise<boolean> {
  const rows = await db
    .select({ headwordId: retranslationLog.headwordId })
    .from(retranslationLog)
    .where(
      and(
        eq(retranslationLog.headwordId, headwordId),
        eq(retranslationLog.fromLanguageCode, FROM),
        eq(retranslationLog.toLanguageCode, TO),
      ),
    );
  return rows.length > 0;
}

/** Open a run for one headword and settle it in the given terminal state. */
async function seedRun(headwordId: string, status: 'ok' | 'failed'): Promise<string> {
  const runId = await createPendingRun(db, {
    headwordId,
    from: FROM,
    to: TO,
    promptVersion: PROMPT_VERSION,
    provider: STUB_PROVIDER,
    model: STUB_MODEL,
  });
  await finishRun(db, runId, status === 'ok' ? { status: 'ok' } : { status: 'failed', error: 'stub failure' });
  return runId;
}

before(async () => {
  if (!DB_HOST) return;

  fixture = await setUpTranslationFixture('reject');
  session = await createTestUserSession('trans-reject');
  secondSession = await createTestUserSession('trans-reject-2');
  await initializeWorkflows();

  answeredHeadwordId = await seedHeadword(fixture, {
    lemma: `zztransreject${fixture.run}`,
    languageCode: FROM,
    pos: 'noun',
  });
  answeredRunId = await seedRun(answeredHeadwordId, 'ok');

  cooldownHeadwordId = await seedHeadword(fixture, {
    lemma: `zztransrejectcool${fixture.run}`,
    languageCode: FROM,
    pos: 'noun',
  });
  cooldownRunId = await seedRun(cooldownHeadwordId, 'ok');
  // Through the real model function rather than a hand-written row, so this
  // fixture cannot drift from what the route stamps.
  await touchRetranslationCooldown(db, { headwordId: cooldownHeadwordId, from: FROM, to: TO });

  failedHeadwordId = await seedHeadword(fixture, {
    lemma: `zztransrejectfail${fixture.run}`,
    languageCode: FROM,
    pos: 'noun',
  });
  await seedRun(failedHeadwordId, 'failed');

  refusedHeadwordId = await seedHeadword(fixture, {
    lemma: `zztransrejectbudget${fixture.run}`,
    languageCode: FROM,
    pos: 'noun',
  });
  await seedRun(refusedHeadwordId, 'ok');
});

after(async () => {
  if (!DB_HOST) {
    await closePool();
    return;
  }

  await stopOrchestrator();

  const seeded = [answeredHeadwordId, cooldownHeadwordId, failedHeadwordId, refusedHeadwordId].filter(
    (id) => id !== '',
  );
  if (seeded.length > 0) {
    // The rejection and signal rows cascade off the runs the fixture deletes.
    // These two do not: `retranslation_log` references `headwords` with no
    // cascade, and the queue rows belong to pg-boss.
    await db.delete(retranslationLog).where(inArray(retranslationLog.headwordId, seeded));
    for (const id of seeded) {
      await db.execute(
        sql`delete from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key like ${`%${id}%`}`,
      );
      await db.delete(workflows).where(sql`${workflows.context}->>'headwordId' = ${id}`);
    }
  }
  if (createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }

  await tearDownTranslationFixture(fixture, []);
  if (session !== null) await session.dispose();
  if (secondSession !== null) await secondSession.dispose();

  await poolInitialized;
  await closePool();
});

describe('rejecting a translation: what is refused before anything is written', () => {
  it(
    'refuses a signed-out rejection with 401 and records nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const factsBefore = await countFacts(answeredRunId);

      const { status, body } = await reject({ headwordId: answeredHeadwordId, reason: 'wrong', cookie: null });

      assert.equal(
        status,
        401,
        `an anonymous rejection answered ${status}. A silent 200 would drop the complaint while telling the ` +
          'reader it counted, and the reader then presses again.',
      );
      assert.equal(body.state, 'unauthenticated');
      assert.equal(
        await countFacts(answeredRunId),
        factsBefore,
        'an anonymous rejection wrote a fact row, so complaints exist that belong to nobody and the ' +
          'one-complaint-per-reader key means nothing',
      );
    },
  );

  it(
    'answers 400 for a reason code the check constraint does not know',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');
      const signalsBefore = await countSignals(answeredRunId);

      const { status, body } = await reject({
        headwordId: answeredHeadwordId,
        reason: 'because-i-said-so',
        cookie: session.cookie,
      });

      assert.equal(
        status,
        400,
        'an unknown reason code reached the insert. The check constraint on the signals table would refuse it ' +
          'as a database error deep in the action, which is a 500 for what is really a bad request.',
      );
      assert.equal(body.state, 'invalid');
      assert.equal(await countSignals(answeredRunId), signalsBefore);
    },
  );

  it(
    'answers no-run for a pair whose latest run did not succeed',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null);

      const { body } = await reject({ headwordId: failedHeadwordId, reason: 'wrong', cookie: session.cookie });

      assert.equal(
        body.state,
        'no-run',
        `expected no-run for a failed pair, got ${JSON.stringify(body)}. There is no answer on screen to have ` +
          'been wrong, and a complaint naming no model output is worthless to the corpus it feeds.',
      );
      assert.equal(await hasCooldown(failedHeadwordId), false, 'a refused rejection started a cooldown');
    },
  );
});

describe('rejecting a translation: the rows one press writes', () => {
  it(
    'writes one fact row and one signal row, and orders the re-run',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null);
      assert.equal(await countFacts(answeredRunId), 0, 'the fixture run already carries a rejection');

      const { body } = await reject({ headwordId: answeredHeadwordId, reason: 'wrong', cookie: session.cookie });

      assert.equal(body.state, 'recorded');
      assert.equal(
        body.rerun,
        'queued',
        `expected the first rejection to order a re-run, got ${JSON.stringify(body)}`,
      );
      assert.equal(
        body.panel?.state,
        'translating',
        'the panel must ride back on a queued re-run, so the pane can switch to its waiting view with no ' +
          'second round trip',
      );
      assert.equal(await countFacts(answeredRunId), 1);
      assert.equal(await countSignals(answeredRunId), 1);

      const [signal] = await db
        .select({ reason: translationRejectionSignals.reason })
        .from(translationRejectionSignals)
        .where(eq(translationRejectionSignals.runId, answeredRunId));
      assert.equal(signal?.reason, 'wrong', 'the reason code the reader chose was not the one stored');

      const [fact] = await db
        .select({ accountId: translationRejections.accountId })
        .from(translationRejections)
        .where(eq(translationRejections.runId, answeredRunId));
      assert.equal(fact?.accountId, session.userId);

      assert.equal(
        await hasCooldown(answeredHeadwordId),
        true,
        'work started and the cooldown was not stamped, so the next reader can order a second paid run of the ' +
          'same word immediately',
      );
    },
  );

  it(
    'leaves the pair with a pending re-run, which is why a repeat press is driven elsewhere',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const runs = await db
        .select({ status: translationRuns.status })
        .from(translationRuns)
        .where(eq(translationRuns.headwordId, answeredHeadwordId))
        .orderBy(desc(translationRuns.createdAt));

      assert.equal(runs.length, 2, 'the re-run opened no row of its own, so the case above proved nothing');
      assert.equal(
        runs[0]?.status,
        'pending',
        'the queued re-run is the LATEST run for this pair now, so `latestRun` no longer reports an answer and ' +
          'the route correctly refuses a second press with no-run. The cases below therefore use a pair whose ' +
          're-run was withheld.',
      );
    },
  );
});

describe('rejecting a translation whose re-run the cooldown withholds', () => {
  it(
    'records the rejection in full and withholds only the paid call',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null);
      assert.equal(await countFacts(cooldownRunId), 0, 'the fixture run already carries a rejection');

      const { body } = await reject({ headwordId: cooldownHeadwordId, reason: 'missing', cookie: session.cookie });

      assert.equal(body.state, 'recorded');
      assert.equal(
        body.rerun,
        'cooldown',
        `expected the window to withhold the re-run, got ${JSON.stringify(body)}`,
      );
      assert.equal(body.panel ?? null, null, 'a withheld re-run carries no panel: nothing about the pair changed');
      assert.equal(
        await countSignals(cooldownRunId),
        1,
        'the cooldown swallowed the SIGNAL as well as the spend. The tally an operator triages on would then ' +
          'systematically under-count exactly the answers most readers disagree with.',
      );
      assert.equal(await countFacts(cooldownRunId), 1);
    },
  );

  it(
    'records nothing new and buys no second call when the same reader presses again',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null);

      const { body } = await reject({ headwordId: cooldownHeadwordId, reason: 'register', cookie: session.cookie });

      assert.equal(body.state, 'recorded');
      assert.equal(body.rerun, 'already');
      assert.equal(body.panel ?? null, null, 'a repeat press carries no panel: nothing about the pair changed');
      assert.equal(
        await countFacts(cooldownRunId),
        1,
        'the second press added a fact row, so one reader holds two complaints about one run',
      );
      assert.equal(
        await countSignals(cooldownRunId),
        1,
        'the second press added a signal row, so one reader pressing twice reads as two people agreeing',
      );
    },
  );

  it(
    'counts a second reader as a second complaint on the same run',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(secondSession !== null, 'the second fixture account was not created');

      const { body } = await reject({
        headwordId: cooldownHeadwordId,
        reason: 'other',
        cookie: secondSession.cookie,
      });

      assert.equal(body.state, 'recorded');
      assert.equal(body.rerun, 'cooldown');
      assert.equal(
        await countFacts(cooldownRunId),
        2,
        'the second reader is not recorded as a second complainant, so the one-per-reader key is being read as ' +
          'one-per-run',
      );
      assert.equal(
        await countSignals(cooldownRunId),
        2,
        'a second reader added no signal row, so the tally cannot tell one angry reader from two agreeing ones',
      );

      const reasons = await db
        .select({ reason: translationRejectionSignals.reason })
        .from(translationRejectionSignals)
        .where(eq(translationRejectionSignals.runId, cooldownRunId));
      assert.deepEqual(
        reasons.map((row) => row.reason).toSorted(),
        ['missing', 'other'],
        'the two readers\' own reason codes were not both kept',
      );
    },
  );
});

describe('rejecting a translation once the day is out of money', () => {
  it(
    'records the rejection, reports refused, and stamps no cooldown',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null);

      // The cap is written HERE rather than in `before`, so every case above
      // ran against a healthy installation. The fixture photographed today's
      // figures before this file started and puts them back in the teardown.
      const day = utcDay(new Date());
      await db
        .insert(dailyBudget)
        .values({ day, reservedUsd: DAILY_BUDGET_USD.toFixed(6), spentUsd: '0.000000' })
        .onConflictDoUpdate({
          target: dailyBudget.day,
          set: { reservedUsd: DAILY_BUDGET_USD.toFixed(6), spentUsd: '0.000000' },
        });

      const { body } = await reject({ headwordId: refusedHeadwordId, reason: 'other', cookie: session.cookie });

      assert.equal(body.state, 'recorded', 'a guard refusal must not swallow the rejection itself');
      assert.equal(body.rerun, 'refused');
      assert.equal(body.panel?.state, 'budget', 'the refusing panel must ride back so the pane can say why');
      assert.equal(
        await hasCooldown(refusedHeadwordId),
        false,
        'a refused re-run stamped the cooldown, which locks this headword out for a day in exchange for a run ' +
          'that never happened',
      );
    },
  );
});
