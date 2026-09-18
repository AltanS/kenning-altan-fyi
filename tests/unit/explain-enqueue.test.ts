/**
 * The explain enqueue: what it writes, in how many transactions, and what it
 * refuses to put on the queue.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   THE LEDGER ROW AND ITS AUTHOR ARE ONE WRITE. Both inserts are given the
 *   SAME transaction handle, and both happen between the transaction opening
 *   and it committing. A version that wrote the author afterwards would pass
 *   every assertion about the finished state and still leave a window in which
 *   an explanation exists with nobody attached to it, which is the defect this
 *   whole shape exists to close. The handle identity is the assertion, because
 *   nothing else distinguishes "inside the transaction" from "after it".
 *
 *   THE JOB IS SENT AFTER THE TRANSACTION COMMITS, never inside it. pg-boss
 *   sends on its own connection, so a send inside a transaction that then rolls
 *   back would leave a queued job pointing at a row that no longer exists.
 *
 *   THE INITIAL VISIBILITY IS THE READER'S OWN PREFERENCE, read through
 *   `getUserProfile` inside the same transaction, and nothing the caller passed
 *   can set it.
 *
 *   THE READER NEVER REACHES THE JOB PAYLOAD. The payload is the privacy
 *   boundary this file's subject states for itself, and a `userId` landing on
 *   `ExplainEnqueueRequest` is exactly the change that could quietly break it.
 *   The assertion is over the payload's own keys, not over a substring search,
 *   so a renamed field cannot smuggle it through.
 *
 * NOTHING HERE OPENS A DATABASE. Every module `enqueueExplain` reads through is
 * replaced, and `#drizzle/db` is stubbed to throw, so a read this file forgot to
 * fake fails loudly instead of hanging on a pool.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowError } from '@sprqvntrs/workflows';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { ExplainJobPayload } from '#app/lib/translation/explain-job-payload';
import type { InsertExplanationAuthorshipParams } from '#app/models/explanation-authorship.server';
import type { InsertPendingExplanationParams } from '#app/models/explanations.server';

mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      throw new Error('the unit tier must not reach a database');
    },
  },
});

/** The row id the faked insert mints, so every assertion can name it. */
const RUN_ID = 'explanation-row-1';

/** The signed-in reader whose request this is. */
const READER_ID = 9871;

/** What the fakes below are told to answer, rewritten by each case. */
interface FakeReads {
  hideNewExplanationsByDefault: boolean;
  /** Whether `orchestrator.start` rejects the way pg-boss does for a duplicate singleton key. */
  duplicate: boolean;
  /** Whether the orchestrator is up at all. */
  orchestratorUp: boolean;
}

const fake: FakeReads = { hideNewExplanationsByDefault: false, duplicate: false, orchestratorUp: true };

/** Which writes happened, in order. The ORDER is what proves the transaction boundary. */
let calls: string[] = [];

// SAFETY: the two handles below are compared by identity and never
// dereferenced. Every function `enqueueExplain` reaches through them is faked in
// this file, so a fake that did touch one would fail on its first property
// access rather than silently querying. `never` is the narrowest way to say
// "this value is not used".
/** The handle the transaction callback is handed. */
const TX_HANDLE = {} as never;

/** Each write's own handle, so a write outside the transaction is visible. */
let pendingHandle: DictionaryDb | null = null;
let profileHandle: DictionaryDb | null = null;
let authorshipHandle: DictionaryDb | null = null;

let pendingParams: InsertPendingExplanationParams | null = null;
let authorshipParams: InsertExplanationAuthorshipParams | null = null;
let profileUserId: number | null = null;
let deletedRunId: string | null = null;
let startedContext: ExplainJobPayload | null = null;

mock.module('#app/models/explanations.server', {
  namedExports: {
    insertPendingExplanation: (handle: DictionaryDb, params: InsertPendingExplanationParams) => {
      calls.push('insertPending');
      pendingHandle = handle;
      pendingParams = params;
      return Promise.resolve(RUN_ID);
    },
    deletePendingExplanation: (handle: DictionaryDb, id: string) => {
      calls.push('deletePending');
      deletedRunId = id;
      return Promise.resolve();
    },
  },
});

mock.module('#app/models/user-profiles.server', {
  namedExports: {
    getUserProfile: (handle: DictionaryDb, userId: number) => {
      calls.push('profile');
      profileHandle = handle;
      profileUserId = userId;
      return Promise.resolve({
        publicName: null,
        hideNewExplanationsByDefault: fake.hideNewExplanationsByDefault,
      });
    },
  },
});

mock.module('#app/models/explanation-authorship.server', {
  namedExports: {
    insertExplanationAuthorship: (handle: DictionaryDb, params: InsertExplanationAuthorshipParams) => {
      calls.push('insertAuthorship');
      authorshipHandle = handle;
      authorshipParams = params;
      return Promise.resolve();
    },
  },
});

mock.module('#app/models/app-settings.server', {
  namedExports: {
    getActiveModel: () => Promise.resolve({ provider: 'openrouter', model: 'a-model' }),
  },
});

/** One queued job, as `orchestrator.start` is given it. */
interface StartedJob {
  type: string;
  context: ExplainJobPayload;
  singletonKey: string;
}

mock.module('#app/services/workflows.server', {
  namedExports: {
    getOrchestrator: () => {
      if (!fake.orchestratorUp) throw new Error('the orchestrator is not initialised');
      return {
        start: (job: StartedJob) => {
          calls.push('start');
          startedContext = job.context;
          // The shape pg-boss's null answer becomes in @sprqvntrs/workflows 0.2.5.
          if (fake.duplicate) throw new WorkflowError('job already queued', 'QUEUE_ERROR');
          return Promise.resolve({ id: 'job-1' });
        },
      };
    },
  },
});

const { enqueueExplain } = await import('#app/lib/translation/explain-enqueue.server');

// SAFETY: the same claim as above. `enqueueExplain` only ever calls
// `transaction` on this object and passes it to faked functions, so the fake
// below is the whole of its observable surface.
/** The database handle under test: a transaction that records its own boundary. */
const db = {
  transaction: async (run: (handle: never) => Promise<string>): Promise<string> => {
    calls.push('transaction:open');
    const runId = await run(TX_HANDLE);
    calls.push('transaction:commit');
    return runId;
  },
} as never;

/** One caller's request. */
function request(overrides: { userId?: number } = {}) {
  return {
    from: 'de',
    to: 'en',
    question: 'Was ist der Unterschied zwischen kennen und wissen?',
    questionNormalized: 'was ist der unterschied zwischen kennen und wissen',
    promptVersion: 2,
    userId: overrides.userId ?? READER_ID,
  } as const;
}

beforeEach(() => {
  calls = [];
  fake.hideNewExplanationsByDefault = false;
  fake.duplicate = false;
  fake.orchestratorUp = true;
  pendingHandle = null;
  profileHandle = null;
  authorshipHandle = null;
  pendingParams = null;
  authorshipParams = null;
  profileUserId = null;
  deletedRunId = null;
  startedContext = null;
});

describe('the row and its author, written together', () => {
  it('opens one transaction, writes both rows inside it, and sends the job only after it commits', async () => {
    const outcome = await enqueueExplain(db, request());

    assert.deepEqual(outcome, { outcome: 'queued', runId: RUN_ID });
    assert.deepEqual(calls, [
      'transaction:open',
      'insertPending',
      'profile',
      'insertAuthorship',
      'transaction:commit',
      'start',
    ]);
  });

  it('hands BOTH writes the transaction handle, not the pool', async () => {
    await enqueueExplain(db, request());

    assert.equal(pendingHandle, TX_HANDLE, 'the ledger row was written outside the transaction');
    assert.equal(authorshipHandle, TX_HANDLE, 'the authorship row was written outside the transaction');
    // The preference is read on the same handle too, so a reader who changes it
    // mid-request cannot be read at one isolation level and written at another.
    assert.equal(profileHandle, TX_HANDLE);
  });

  it('names the row it just minted, and the reader who asked for it', async () => {
    const asked = request();
    await enqueueExplain(db, asked);

    assert.equal(profileUserId, READER_ID);
    assert.deepEqual(authorshipParams, { explanationId: RUN_ID, userId: READER_ID, listed: true });
    // The ledger row itself still carries no reader: the question, the two
    // languages and the model are the whole of what it is given.
    assert.deepEqual(pendingParams, {
      from: asked.from,
      to: asked.to,
      question: asked.question,
      questionNormalized: asked.questionNormalized,
      promptVersion: asked.promptVersion,
      provider: 'openrouter',
      model: 'a-model',
    });
  });
});

describe('the initial visibility, from the reader own preference', () => {
  it('starts listed for a reader who has never set the preference', async () => {
    await enqueueExplain(db, request());
    assert.equal(authorshipParams?.listed, true);
  });

  it('starts hidden for a reader who asked for that, and asks the profile before it writes', async () => {
    fake.hideNewExplanationsByDefault = true;
    await enqueueExplain(db, request());

    assert.equal(authorshipParams?.listed, false);
    assert.ok(
      calls.indexOf('profile') < calls.indexOf('insertAuthorship'),
      'the preference must be read before the row that carries it is written',
    );
  });
});

describe('the job payload, which still names nobody', () => {
  it('carries the fold, the two languages, the prompt version and the row id, and NOTHING else', async () => {
    await enqueueExplain(db, request());

    assert.deepEqual(Object.keys(startedContext ?? {}).toSorted(), [
      'from',
      'promptVersion',
      'questionNormalized',
      'runId',
      'to',
    ]);
  });

  it('carries neither the reader nor the question as typed', async () => {
    await enqueueExplain(db, request({ userId: 4242 }));

    const serialized = JSON.stringify(startedContext);
    assert.equal(serialized.includes('4242'), false, 'the reader reached the job payload');
    assert.equal(serialized.includes('Unterschied'), false, 'the question as typed reached the job payload');
  });
});

describe('the paths that write no author at all', () => {
  it('opens no transaction when the orchestrator is not up', async () => {
    fake.orchestratorUp = false;
    const outcome = await enqueueExplain(db, request());

    assert.deepEqual(outcome, { outcome: 'unavailable', runId: null });
    assert.deepEqual(calls, []);
  });

  it('removes the ledger row it opened when the key was already queued, taking the author with it', async () => {
    fake.duplicate = true;
    const outcome = await enqueueExplain(db, request());

    assert.deepEqual(outcome, { outcome: 'deduped', runId: null });
    // The authorship row needs no delete of its own: the FK cascades off the
    // row this removes. The integration tier proves that against a real
    // database; what this asserts is that the ledger row is removed at all.
    assert.equal(deletedRunId, RUN_ID);
  });
});
