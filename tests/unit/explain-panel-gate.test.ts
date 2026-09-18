/**
 * The explain gate: which answer a typed question gets, and in what order the
 * four guards are asked.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   Every path through `resolveTriggeredExplainPanel` decides whether a model is
 *   called, and this is the most expensive call this app makes. A question the
 *   cache already answers must never reach the rate limiter, or the honest
 *   majority of readers, the ones asking something this installation has already
 *   paid for, would be the ones exhausting the limit while a script pasting
 *   fresh questions kept its full allowance. A failed question must not
 *   re-enqueue on every reload, or one provider outage becomes a job per page
 *   view. And the LENGTH CAP is asked first of the four, because it is free and
 *   certain: a question over the cap can never be answered however much budget
 *   is left, so every other question about it would be work spent on a refusal
 *   that was already decided.
 *
 *   THE REFUSAL WRITES NOTHING. That is asserted too: no row is opened on a
 *   refused path, so nothing newer than the existing state exists and a reader
 *   coming back under a fresh allowance reaches the same enqueue this one did
 *   not.
 *
 * THE READS ARE FAKED, ALL SIX OF THEM. `explain-panel.server.ts` reads the
 * cache, the ledger, the rate limiter, the budget, the queue and, since M200/02,
 * the vote table, each through its own module, and each one is replaced here.
 * Nothing in this file opens a database: `#drizzle/db` connects at module load
 * and is stubbed to throw, so a read this test forgot to fake fails loudly
 * instead of hanging on a pool.
 *
 * THE VOTE READS GO IN THEIR OWN LOG, NOT IN `calls`. The gate-order assertions
 * below are exact `deepEqual`s on `calls`, so folding two more entries into it
 * would have rewritten every one of them and turned an order proof into a
 * transcript nobody can read. `voteReads` answers a different question: WHICH
 * vote statements ran, and on whose behalf.
 *
 * THE CALL LOG IS THE ASSERTION FOR ORDER. Asserting only the returned reason
 * would pass on an implementation that asked all four guards and picked a winner
 * afterwards, which is a different program: it would spend a rate-limit token on
 * a request the length cap had already turned away.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { Explanation } from '#app/lib/llm/explain-schema';
import type { ExplainEnqueueRequest } from '#app/lib/translation/explain-enqueue.server';
import type { VoteTally } from '#app/lib/votes/score';
import type { ExplanationView } from '#app/models/explanations.server';
import type { VoteValue } from '#app/models/votes.server';

mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      throw new Error('the unit tier must not reach a database');
    },
  },
});

/** What the fakes below are told to answer, rewritten by each case. */
interface FakeReads {
  answer: ExplanationView | null;
  latest: ExplanationView | null;
  rateLimitAllowed: boolean;
  budgetExhausted: boolean;
  runsToday: number;
  enqueueOutcome: 'queued' | 'deduped' | 'unavailable';
  /** What the shared tally answers for the answered row. */
  tally: VoteTally;
  /** What the per-account read answers, when it is performed at all. */
  storedVote: VoteValue | null;
}

const fake: FakeReads = {
  answer: null,
  latest: null,
  rateLimitAllowed: true,
  budgetExhausted: false,
  runsToday: 0,
  enqueueOutcome: 'queued',
  tally: { up: 0, down: 0 },
  storedVote: null,
};

/** Which reads happened, in order. The gate ORDER is what this proves. */
let calls: string[] = [];

mock.module('#app/models/explanations.server', {
  namedExports: {
    latestExplanationAnswer: () => {
      calls.push('cache');
      return Promise.resolve(fake.answer);
    },
    latestExplanation: () => {
      calls.push('latest');
      return Promise.resolve(fake.latest);
    },
    countExplainRunsToday: () => {
      calls.push('countRunsToday');
      return Promise.resolve(fake.runsToday);
    },
  },
});

/** One statement the vote table was asked for, and on whose behalf. */
interface VoteRead {
  kind: 'tally' | 'account';
  explanationId: string;
  accountId?: number;
}

/**
 * Which vote statements ran, in order.
 *
 * THE ABSENCE OF AN `account` ENTRY IS THE ASSERTION FOR A STRANGER. "No
 * per-account read happens" cannot be proved by reading `myVote`, which is
 * `null` both when the read was skipped and when it ran and found nothing.
 */
let voteReads: VoteRead[] = [];

mock.module('#app/models/explanation-votes.server', {
  namedExports: {
    tallyExplanationVotes: (_db: DictionaryDb, explanationId: string) => {
      voteReads.push({ kind: 'tally', explanationId });
      return Promise.resolve(fake.tally);
    },
    readVoteForAccount: (_db: DictionaryDb, params: { explanationId: string; accountId: number }) => {
      voteReads.push({ kind: 'account', explanationId: params.explanationId, accountId: params.accountId });
      return Promise.resolve(fake.storedVote);
    },
  },
});

mock.module('#app/lib/abuse/rate-limit.server', {
  namedExports: {
    checkTriggerRateLimit: () => {
      calls.push('rateLimit');
      return Promise.resolve({ allowed: fake.rateLimitAllowed });
    },
  },
});

mock.module('#app/lib/abuse/budget.server', {
  namedExports: {
    isBudgetExhausted: () => {
      calls.push('budget');
      return Promise.resolve(fake.budgetExhausted);
    },
  },
});

/**
 * What the resolver last handed the enqueue.
 *
 * THE READER IS THE PART THIS FILE WATCHES. `enqueueExplain` opens a row and
 * writes its author in one transaction, so a resolver that dropped the reader on
 * the floor would leave every row it opened unauthored, and nothing in the
 * returned panel would say so.
 */
let enqueued: ExplainEnqueueRequest | null = null;

mock.module('#app/lib/translation/explain-enqueue.server', {
  namedExports: {
    enqueueExplain: (_db: DictionaryDb, request: ExplainEnqueueRequest) => {
      calls.push('enqueue');
      enqueued = request;
      return Promise.resolve(
        fake.enqueueOutcome === 'queued' ?
          { outcome: 'queued', runId: 'explain-1' }
        : { outcome: fake.enqueueOutcome, runId: null },
      );
    },
  },
});

const { explainKeyFromRequest, resolveExplainPanel, resolveTriggeredExplainPanel } = await import(
  '#app/lib/translation/explain-panel.server'
);
const { MAX_EXPLAIN_RUNS_PER_DAY, EXPLAIN_MAX_QUESTION_CHARS } = await import('#app/lib/translation/limits');

// SAFETY: every read this module performs is faked above, so the handle is
// passed from function to function and never dereferenced. `never` is the
// narrowest way to say "this value is not used", and any fake that did touch it
// would fail on the first property access rather than silently querying.
/** The database handle every function here takes and none of the fakes reads. */
const db = {} as never;

/** The question under test. */
const key = {
  question: 'What is the difference between kennen and wissen?',
  questionNormalized: 'what is the difference between kennen and wissen',
  from: 'de',
  to: 'en',
} as const;

/**
 * The same question, addressed by one reader or by nobody.
 *
 * THE ACCOUNT IS NOT PART OF THE KEY, which is why it is a second argument here
 * rather than a field on `key` above: `explainKeyFromRequest` still answers the
 * four-field key, and its own case at the bottom of this file proves it.
 *
 * @param accountId The signed-in reader, or `null` for a stranger.
 */
function lookup(accountId: number | null = null) {
  return { ...key, accountId };
}

const request = new Request('https://kenning.altan.fyi/explain?q=kennen%20wissen');

/** The signed-in reader every trigger in this file asks as. */
const READER_ID = 4242;

/** One answered explanation, the smallest the card will draw. */
const answer: Explanation = {
  answer: 'kennen is about people and places, wissen is about facts.',
  terms: [],
  contrasts: [],
  pitfalls: [],
  related: [],
  references: [],
};

/** One explanation row, with only the fields the resolver reads filled in. */
function row(status: ExplanationView['status'], overrides: Partial<ExplanationView> = {}) {
  return {
    id: 'explain-0',
    from: key.from,
    to: key.to,
    question: key.question,
    questionNormalized: key.questionNormalized,
    status,
    answer: null,
    provider: 'openrouter',
    model: 'a-model',
    promptVersion: 1,
    costUsd: null,
    latencyMs: null,
    error: null,
    createdAt: new Date('2026-09-17T10:00:00.000Z'),
    finishedAt: null,
    ...overrides,
  } satisfies ExplanationView;
}

beforeEach(() => {
  calls = [];
  voteReads = [];
  enqueued = null;
  fake.tally = { up: 0, down: 0 };
  fake.storedVote = null;
  fake.answer = null;
  fake.latest = null;
  fake.rateLimitAllowed = true;
  fake.budgetExhausted = false;
  fake.runsToday = 0;
  fake.enqueueOutcome = 'queued';
});

describe('the explain resolver, which never enqueues', () => {
  it('serves the cached answer with the row id and the model that wrote it, without reading the ledger', async () => {
    fake.answer = row('ok', { answer });
    const panel = await resolveExplainPanel(db, lookup());
    assert.deepEqual(panel, {
      state: 'ready',
      answer,
      explanationId: 'explain-0',
      model: 'a-model',
      up: 0,
      down: 0,
      myVote: null,
    });
    // The ledger is not even read: an answer on the screen is the answer,
    // whatever a later attempt to produce another one did.
    assert.deepEqual(calls, ['cache']);
  });

  it('serves a stranger the shared tally and no vote of their own, without reading the vote table per account', async () => {
    fake.answer = row('ok', { answer });
    fake.tally = { up: 5, down: 2 };
    // Set, and it must NOT come back: a read that ran on behalf of a reader the
    // request cannot name would be the defect this case exists to catch.
    fake.storedVote = 1;

    const panel = await resolveExplainPanel(db, lookup(null));

    assert.equal(panel.state, 'ready');
    assert.deepEqual(panel, {
      state: 'ready',
      answer,
      explanationId: 'explain-0',
      model: 'a-model',
      up: 5,
      down: 2,
      myVote: null,
    });
    assert.deepEqual(
      voteReads,
      [{ kind: 'tally', explanationId: 'explain-0' }],
      'a signed-out read reached the per-account statement. The score is a property of the answer and is read for ' +
        'everybody; who voted on it is not, and must never be asked on behalf of a reader with no account.',
    );
  });

  it("carries a signed-in reader's stored vote back, so the button comes back pressed after a reload", async () => {
    fake.answer = row('ok', { answer });
    fake.tally = { up: 4, down: 1 };
    fake.storedVote = -1;

    const panel = await resolveExplainPanel(db, lookup(READER_ID));

    assert.deepEqual(panel, {
      state: 'ready',
      answer,
      explanationId: 'explain-0',
      model: 'a-model',
      up: 4,
      down: 1,
      myVote: -1,
    });
    assert.deepEqual(voteReads, [
      { kind: 'tally', explanationId: 'explain-0' },
      { kind: 'account', explanationId: 'explain-0', accountId: READER_ID },
    ]);
  });

  it('asks the vote table nothing at all while a run is open or after it failed', async () => {
    fake.latest = row('pending');
    await resolveExplainPanel(db, lookup(READER_ID));
    fake.latest = row('failed');
    await resolveExplainPanel(db, lookup(READER_ID));

    assert.deepEqual(
      voteReads,
      [],
      'an unanswered question paid for two vote statements. The pane polls this every three seconds, so a tally ' +
        'read on the waiting path is a query per poll for a score that cannot exist yet.',
    );
  });

  it('reports translating for an open run, and failed for the latest failed one', async () => {
    fake.latest = row('pending');
    assert.deepEqual(await resolveExplainPanel(db, lookup()), { state: 'translating', queuedRunId: null });

    fake.latest = row('failed', { error: 'the model answered nothing usable' });
    assert.deepEqual(await resolveExplainPanel(db, lookup()), {
      state: 'failed',
      canRetry: true,
      error: 'the model answered nothing usable',
    });
  });

  it('reports none for a question nobody has asked, and for an ok row whose document does not decode', async () => {
    assert.deepEqual(await resolveExplainPanel(db, lookup()), { state: 'none' });
    // `answer: null` here is what the model layer produces for a stored document
    // this version cannot read. It must not render as an empty answer.
    fake.latest = row('ok');
    assert.deepEqual(await resolveExplainPanel(db, lookup()), { state: 'none' });
  });

  it('never enqueues and never spends a rate-limit token, whatever it is asked', async () => {
    await resolveExplainPanel(db, lookup());
    fake.latest = row('failed');
    await resolveExplainPanel(db, lookup());
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.includes('rateLimit'), false);
  });
});

describe('the explain trigger, which may', () => {
  it('short-circuits a cached question before any guard runs, and never spends a rate-limit token', async () => {
    fake.answer = row('ok', { answer });
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.equal(panel.state, 'ready');
    assert.deepEqual(calls, ['cache']);
  });

  it("reports the asking reader's own vote on a question the cache already answers", async () => {
    fake.answer = row('ok', { answer });
    fake.tally = { up: 2, down: 0 };
    fake.storedVote = 1;

    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });

    assert.equal(panel.state, 'ready');
    // SAFETY: the state was just asserted, and `ready` is the only member of the
    // union that carries a tally.
    assert.deepEqual(
      panel.state === 'ready' ? { up: panel.up, down: panel.down, myVote: panel.myVote } : null,
      { up: 2, down: 0, myVote: 1 },
    );
    assert.deepEqual(
      voteReads.find((read) => read.kind === 'account'),
      { kind: 'account', explanationId: 'explain-0', accountId: READER_ID },
      'the trigger half built its lookup without the reader it was handed, so a reader who asks a question this ' +
        'installation has already answered is shown the buttons unpressed and votes again',
    );
  });

  it('short-circuits an open run, so a second identical question queues nothing', async () => {
    fake.latest = row('pending');
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.equal(panel.state, 'translating');
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.includes('rateLimit'), false);
  });

  it('leaves a failure alone unless the reader asked again', async () => {
    fake.latest = row('failed');
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.deepEqual(panel, { state: 'failed', canRetry: true, error: null });
    assert.equal(calls.includes('enqueue'), false);
  });

  it('enqueues for a question nobody has asked, asking the four guards in order', async () => {
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.deepEqual(panel, { state: 'translating', queuedRunId: 'explain-1' });
    assert.deepEqual(calls, ['cache', 'latest', 'rateLimit', 'countRunsToday', 'budget', 'enqueue']);
  });

  it('hands the reader to the enqueue, so the row it opens can be written with its author', async () => {
    await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.equal(enqueued?.userId, READER_ID, 'the resolver dropped the reader on the way to the enqueue');
    // And it is the resolver's own caller-supplied value, not a default: the
    // whole question, the fold and the two languages travel beside it unchanged.
    assert.equal(enqueued?.questionNormalized, key.questionNormalized);
  });

  it('never reaches the enqueue on a refused question, so no reader is recorded either', async () => {
    fake.rateLimitAllowed = false;
    await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.equal(enqueued, null);
  });

  it('refuses a question over the length cap first of all, before any other question is asked', async () => {
    const tooLong = 'a'.repeat(EXPLAIN_MAX_QUESTION_CHARS + 1);
    const panel = await resolveTriggeredExplainPanel(db, {
      ...key,
      question: tooLong,
      questionNormalized: tooLong,
      request,
      userId: READER_ID,
    });
    assert.deepEqual(panel, { state: 'budget', reason: 'too-long' });
    // The two reads that decide the state still happen, because the cap is a
    // guard on STARTING work and a question this long may already have an
    // answer. Past them, nothing: no counter is read and no token is spent.
    assert.deepEqual(calls, ['cache', 'latest']);
  });

  it('accepts a question exactly at the cap, so the boundary is not off by one', async () => {
    const atCap = 'a'.repeat(EXPLAIN_MAX_QUESTION_CHARS);
    const panel = await resolveTriggeredExplainPanel(db, {
      ...key,
      question: atCap,
      questionNormalized: atCap,
      request,
      userId: READER_ID,
    });
    assert.deepEqual(panel, { state: 'translating', queuedRunId: 'explain-1' });
    assert.equal(calls.at(-1), 'enqueue');
  });

  it('refuses a rate-limited caller before it reads either installation-wide counter', async () => {
    fake.rateLimitAllowed = false;
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.deepEqual(panel, { state: 'budget', reason: 'rate-limited' });
    assert.deepEqual(calls, ['cache', 'latest', 'rateLimit']);
  });

  it('refuses at the day cap before it asks the budget', async () => {
    fake.runsToday = MAX_EXPLAIN_RUNS_PER_DAY;
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.deepEqual(panel, { state: 'budget', reason: 'daily-cap' });
    assert.deepEqual(calls, ['cache', 'latest', 'rateLimit', 'countRunsToday']);
  });

  it('refuses on an exhausted budget, last of the four', async () => {
    fake.budgetExhausted = true;
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.deepEqual(panel, { state: 'budget', reason: 'budget' });
    assert.deepEqual(calls, ['cache', 'latest', 'rateLimit', 'countRunsToday', 'budget']);
  });

  it('re-enqueues a failure when the reader pressed retry', async () => {
    fake.latest = row('failed');
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, retry: true, userId: READER_ID });
    assert.deepEqual(panel, { state: 'translating', queuedRunId: 'explain-1' });
    assert.equal(calls.at(-1), 'enqueue');
  });

  it('treats a deduped enqueue as translating with no id of its own, and an unavailable queue as failed', async () => {
    fake.enqueueOutcome = 'deduped';
    assert.deepEqual(await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID }), {
      state: 'translating',
      queuedRunId: null,
    });

    fake.enqueueOutcome = 'unavailable';
    const panel = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.deepEqual(panel, {
      state: 'failed',
      canRetry: true,
      error: 'the explain queue is not available',
    });
  });

  it('mints the row id on a fresh queue, and answers no id when the same key is asked again while it is still open', async () => {
    const first = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.deepEqual(first, { state: 'translating', queuedRunId: 'explain-1' });

    // The real `enqueueExplain` answers `deduped` for the second reader who asks
    // the same key while the first run is still open; the fake models that
    // outcome directly here, since the singleton-key race itself is proved by
    // the integration test, not by this fake.
    fake.enqueueOutcome = 'deduped';
    const second = await resolveTriggeredExplainPanel(db, { ...key, request, userId: READER_ID });
    assert.deepEqual(second, { state: 'translating', queuedRunId: null });
  });
});

describe('the polling key, read out of a query string', () => {
  it('folds the question the same way the cache key was written, so a poll finds its own row', () => {
    const url = new URL(
      'https://kenning.altan.fyi/api/explain?q=%20What%20is%20the%20difference%20between%20kennen%20and%20wissen%3F%20&from=de&to=en',
    );
    assert.deepEqual(explainKeyFromRequest(url), {
      question: 'What is the difference between kennen and wissen?',
      questionNormalized: 'what is the difference between kennen and wissen',
      from: 'de',
      to: 'en',
    });
  });

  it('answers null for an empty question and for a language this installation does not serve', () => {
    assert.equal(explainKeyFromRequest(new URL('https://x.test/?q=&from=de&to=en')), null);
    assert.equal(explainKeyFromRequest(new URL('https://x.test/?q=hallo&from=de&to=fr')), null);
    assert.equal(explainKeyFromRequest(new URL('https://x.test/?q=hallo&to=en')), null);
  });
});
