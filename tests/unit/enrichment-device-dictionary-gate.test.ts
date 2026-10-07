/**
 * The enrichment gate for the device dictionary (M209): with the `device-dict`
 * cookie listing the direction, a single-word search reads the enrichment panel
 * and queues NOTHING; without it, the search path is the one it always was.
 *
 * WHAT THIS HOLDS IN PLACE, AND WHY IT IS A TEST AND NOT A COMMENT
 *   M208 deferred the AI translation behind a device hit. A browser walk on
 *   2026-10-07 then found the explanation job still queued on page load: for
 *   `kettle` (en to de) a `pgboss.job` named `enrichment` existed before anyone
 *   pressed a button. Four things keep that from coming back, each asserted here:
 *     1. The mapping. The read-only half answers `pending` for an entry with
 *        senses and nothing cached EVEN WHEN NOTHING IS QUEUED. Returned to a
 *        screen that polls pending panels, that is skeletons for work that does
 *        not exist, so a deferred `pending` and a retryable `failed` become the
 *        idle `on-request` panel. Everything else passes through.
 *     2. The effect. Run through the REAL `resolveEnrichmentPanel` and
 *        `resolveTriggeredPanel` over faked reads, a deferred panel calls no rate
 *        limit, no budget check and no enqueue, and an undeferred one still does.
 *        Asserting only the mapping would pass on a loader that chose right and
 *        then called both anyway.
 *     3. The wiring. `translate.tsx` calls `resolveTriggeredPanel` ONLY inside the
 *        gate's `trigger` thunk. The loader needs a database to run, so this reads
 *        its source with comments stripped.
 *     4. The route and the entry page. The new POST route is the only other
 *        caller of the triggering resolver among the screens' own files, and the
 *        entry page is not deferred.
 *
 * THE READS ARE FAKED THE WAY `device-dictionary-loader-gate.test.ts` FAKES
 * THEM: `#drizzle/db` is stubbed to throw, so a read this file forgot to fake
 * fails loudly instead of hanging on a pool.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { EnrichmentPanel, EnrichmentPanelSense } from '#app/lib/enrichment/state.server';
import type { EnrichmentView } from '#app/models/enrichments.server';

mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      throw new Error('the unit tier must not reach a database');
    },
  },
});

/** What the fakes below answer, rewritten by each case. */
interface FakeReads {
  rows: EnrichmentView[];
  latest: { failed: boolean; at: Date } | null;
  rateLimitAllowed: boolean;
  budgetExhausted: boolean;
}

const fake: FakeReads = { rows: [], latest: null, rateLimitAllowed: true, budgetExhausted: false };

/** Which reads and effects happened, in order. */
let calls: string[] = [];

mock.module('#app/models/app-settings.server', {
  namedExports: {
    getActiveModel: () => {
      calls.push('activeModel');
      return Promise.resolve({ provider: 'openrouter', model: 'a-model' });
    },
  },
});

mock.module('#app/lib/llm/registry.server', {
  namedExports: { registry: { describeConfiguration: () => ({ configured: true }) } },
});

mock.module('#app/models/enrichments.server', {
  namedExports: {
    listCachedEnrichments: () => {
      calls.push('cache');
      return Promise.resolve(fake.rows);
    },
    latestAttempt: () => {
      calls.push('latestAttempt');
      return Promise.resolve(fake.latest);
    },
  },
});

mock.module('#app/models/votes.server', {
  namedExports: {
    tallyVotes: () => Promise.resolve({ up: 0, down: 0 }),
    readVotesForAccount: () => Promise.resolve(new Map()),
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

mock.module('#app/lib/enrichment/enqueue.server', {
  namedExports: {
    enqueueEnrichmentInBackground: () => {
      calls.push('enqueue');
    },
  },
});

const { resolveWordEnrichmentPanel } = await import('#app/lib/enrichment/device-dictionary-gate');
const { resolveEnrichmentPanel } = await import('#app/lib/enrichment/state.server');
const { resolveTriggeredPanel } = await import('#app/lib/enrichment/trigger.server');

// SAFETY: every read the resolvers perform is faked above, so the handle is passed
// along and never dereferenced. Any fake that did touch it would fail on the first
// property access rather than silently querying.
/** The database handle every resolver takes and no fake reads. */
const db = {} as never;

const key = { headwordId: '99a991dc-8e80-4b65-82e5-effbbaf84269', from: 'en', to: 'de' } as const;
const SENSE_IDS = ['sense-1', 'sense-2'];
const request = new Request('https://kenning.altan.fyi/?q=kettle');

/** One cached row, as the cache read returns it. */
function row(senseId: string): EnrichmentView {
  return {
    id: `enrichment-${senseId}`,
    senseId,
    provider: 'openrouter',
    model: 'a-model',
    promptVersion: 1,
    output: {
      senseId,
      translation: ['Kessel'],
      explanation: 'a pot',
      register: 'neutral',
      usageNotes: 'none',
      examples: [
        { text: 'a', translation: 'b' },
        { text: 'c', translation: 'd' },
        { text: 'e', translation: 'f' },
      ],
      commonMistakes: [],
    },
    createdAt: new Date('2026-10-07T10:00:00.000Z'),
  };
}

/** The panel the loader would put in its data, chosen the way the loader chooses it. */
function loaderPanel(isDeferred: boolean): Promise<EnrichmentPanel> {
  return resolveWordEnrichmentPanel({
    isDeferred,
    read: () => resolveEnrichmentPanel(db, { ...key, senseIds: SENSE_IDS }),
    trigger: () => resolveTriggeredPanel({ db, request, ...key, senseIds: SENSE_IDS }),
  });
}

const ONE_DAY_MS = 86_400_000;

beforeEach(() => {
  calls = [];
  fake.rows = [];
  fake.latest = null;
  fake.rateLimitAllowed = true;
  fake.budgetExhausted = false;
});

/** One cached sense, as a panel carries it. */
const SENSE: EnrichmentPanelSense = {
  enrichmentId: 'e-1',
  senseId: 'sense-1',
  provider: 'openrouter',
  model: 'a-model',
  promptVersion: 1,
  output: row('sense-1').output,
  up: 1,
  down: 0,
  myVote: null,
};

/** The six panels the read-only half can produce, with the cached sense a partial run leaves. */
const PENDING: EnrichmentPanel = {
  state: 'pending',
  reason: null,
  model: 'a-model',
  from: 'en',
  senses: [SENSE],
  refusal: null,
};
const FAILED_RETRYABLE: EnrichmentPanel = {
  state: 'failed',
  reason: null,
  model: 'a-model',
  from: 'en',
  senses: [SENSE],
  retryable: true,
  refusal: null,
};
const FAILED_RECENT: EnrichmentPanel = { ...FAILED_RETRYABLE, retryable: false };
const READY: EnrichmentPanel = { state: 'ready', reason: null, model: 'a-model', from: 'en', senses: [SENSE] };
const NOT_CONFIGURED: EnrichmentPanel = {
  state: 'idle',
  reason: 'not-configured',
  model: 'a-model',
  from: 'en',
  senses: [],
};
const NOT_REQUESTED: EnrichmentPanel = { state: 'idle', reason: 'not-requested', model: null, from: 'en', senses: [] };
const ON_REQUEST: EnrichmentPanel = {
  state: 'idle',
  reason: 'on-request',
  model: 'a-model',
  from: 'en',
  senses: [SENSE],
};

/** Run the gate over two counting resolvers that answer the given panels. */
async function runGate(opts: {
  isDeferred: boolean;
  read: EnrichmentPanel;
  trigger?: EnrichmentPanel;
}): Promise<{ panel: EnrichmentPanel; called: string[] }> {
  const called: string[] = [];
  const panel = await resolveWordEnrichmentPanel({
    isDeferred: opts.isDeferred,
    read: () => {
      called.push('read');
      return Promise.resolve(opts.read);
    },
    trigger: () => {
      called.push('trigger');
      return Promise.resolve(opts.trigger ?? opts.read);
    },
  });
  return { panel, called };
}

describe('the mapping table, deferred', () => {
  it('pending becomes idle on-request, keeping the model, the language and the cached senses', async () => {
    const { panel, called } = await runGate({ isDeferred: true, read: PENDING });
    assert.deepEqual(panel, ON_REQUEST);
    assert.deepEqual(called, ['read']);
  });

  it('a retryable failure becomes the same idle panel, so the reader can ask again', async () => {
    const { panel } = await runGate({ isDeferred: true, read: FAILED_RETRYABLE });
    assert.deepEqual(panel, ON_REQUEST);
  });

  it('a failure that is not yet retryable stays failed', async () => {
    const { panel } = await runGate({ isDeferred: true, read: FAILED_RECENT });
    assert.deepEqual(panel, FAILED_RECENT);
  });

  it('ready passes through: a stored explanation still wins', async () => {
    const { panel } = await runGate({ isDeferred: true, read: READY });
    assert.deepEqual(panel, READY);
  });

  it('every idle passes through: not-configured and not-requested are not replaced', async () => {
    assert.deepEqual((await runGate({ isDeferred: true, read: NOT_CONFIGURED })).panel, NOT_CONFIGURED);
    assert.deepEqual((await runGate({ isDeferred: true, read: NOT_REQUESTED })).panel, NOT_REQUESTED);
    assert.deepEqual((await runGate({ isDeferred: true, read: ON_REQUEST })).panel, ON_REQUEST);
  });

  it('never calls trigger, whatever read answers', async () => {
    for (const read of [PENDING, FAILED_RETRYABLE, FAILED_RECENT, READY, NOT_CONFIGURED, NOT_REQUESTED]) {
      const { called } = await runGate({ isDeferred: true, read });
      assert.deepEqual(called, ['read'], read.state);
    }
  });

  it('never returns a pending panel, because nothing is queued for it to wait on', async () => {
    for (const read of [PENDING, FAILED_RETRYABLE, FAILED_RECENT, READY, NOT_CONFIGURED, NOT_REQUESTED]) {
      const { panel } = await runGate({ isDeferred: true, read });
      assert.notEqual(panel.state, 'pending', `a deferred ${read.state} panel came out pending`);
    }
  });
});

describe('the mapping table, not deferred', () => {
  it('returns exactly what trigger answers, for every state, and never calls read', async () => {
    for (const trigger of [PENDING, FAILED_RETRYABLE, FAILED_RECENT, READY, NOT_CONFIGURED, NOT_REQUESTED]) {
      const { panel, called } = await runGate({ isDeferred: false, read: ON_REQUEST, trigger });
      assert.equal(panel, trigger, trigger.state);
      assert.deepEqual(called, ['trigger']);
    }
  });

  it('does not map a pending trigger answer: that one IS running', async () => {
    const { panel } = await runGate({ isDeferred: false, read: ON_REQUEST, trigger: PENDING });
    assert.equal(panel.state, 'pending');
  });
});

describe('what the real resolvers do under each choice', () => {
  it('cookie set and nothing cached: on-request, and NOTHING is queued or counted', async () => {
    const panel = await loaderPanel(true);

    assert.equal(panel.state, 'idle');
    assert.equal(panel.state === 'idle' ? panel.reason : null, 'on-request');
    assert.deepEqual(calls, ['activeModel', 'cache', 'latestAttempt']);
    for (const spend of ['enqueue', 'rateLimit', 'budget']) {
      assert.equal(calls.includes(spend), false, `a deferred search touched "${spend}"`);
    }
  });

  it('cookie absent: the same entry still queues, behind both guards, exactly as before', async () => {
    const panel = await loaderPanel(false);

    assert.equal(panel.state, 'pending');
    assert.deepEqual(calls, ['activeModel', 'cache', 'latestAttempt', 'rateLimit', 'budget', 'enqueue']);
  });

  it('cookie set and a failure older than the retry window: on-request, and nothing is queued', async () => {
    fake.latest = { failed: true, at: new Date(Date.now() - ONE_DAY_MS) };

    const panel = await loaderPanel(true);

    assert.equal(panel.state === 'idle' ? panel.reason : null, 'on-request');
    assert.equal(calls.includes('enqueue'), false);
  });

  it('cookie set and a recent failure: it stays failed, as the trigger half would leave it', async () => {
    fake.latest = { failed: true, at: new Date() };

    const panel = await loaderPanel(true);

    assert.equal(panel.state, 'failed');
    assert.equal(calls.includes('enqueue'), false);
  });

  it('cookie set and every sense cached: ready, with no read of the queue or the guards', async () => {
    fake.rows = SENSE_IDS.map(row);

    const panel = await loaderPanel(true);

    assert.equal(panel.state, 'ready');
    assert.deepEqual(calls, ['activeModel', 'cache']);
  });
});

describe('the request route runs the SAME guarded path the page load does', () => {
  it('a rate-limited request is refused with the same pending panel, and queues nothing', async () => {
    fake.rateLimitAllowed = false;

    const panel = await resolveTriggeredPanel({ db, request, ...key, senseIds: SENSE_IDS });

    assert.equal(panel.state === 'pending' ? panel.refusal : null, 'rate-limited');
    assert.equal(calls.includes('enqueue'), false);
  });

  it('an exhausted budget is refused after the rate limit, and queues nothing', async () => {
    fake.budgetExhausted = true;

    const panel = await resolveTriggeredPanel({ db, request, ...key, senseIds: SENSE_IDS });

    assert.equal(panel.state === 'pending' ? panel.refusal : null, 'budget');
    assert.deepEqual(calls.slice(-2), ['rateLimit', 'budget']);
    assert.equal(calls.includes('enqueue'), false);
  });
});

/** A file as text with its comments removed, so a name written in a comment cannot satisfy or trip a check. */
function readCode(path: string): string {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/['"`]/.test(line.split('//')[0] ?? '') ? line : (line.split('//')[0] ?? '')))
    .join('\n');
}

describe('the loader wires the enrichment gate in, and only through the gate', () => {
  const LOADER = readCode('../../app/routes/translate.tsx');

  it('calls resolveTriggeredPanel exactly once, inside the gate trigger thunk', () => {
    const calls_ = [...LOADER.matchAll(/\bresolveTriggeredPanel\(/g)];
    assert.equal(calls_.length, 1, 'the loader calls resolveTriggeredPanel outside the gate, or not at all');
    assert.match(
      LOADER,
      /resolveWordEnrichmentPanel\(\{\s*isDeferred: deviceDictionary,[\s\S]*?trigger: \(\) =>\s*resolveTriggeredPanel\(\{/,
    );
  });

  it('reads the cache through the read-only resolver and names no enqueue of its own', () => {
    assert.match(LOADER, /read: \(\) =>\s*resolveEnrichmentPanel\(db, \{/);
    assert.doesNotMatch(LOADER, /enqueueEnrichment/);
  });

  it('is deferred by the flag the loader returns, not by a second reading of the cookie', () => {
    assert.equal([...LOADER.matchAll(/isDeviceDictionaryDirection\(/g)].length, 1);
  });
});

describe('the entry page is not deferred', () => {
  const ENTRY = readCode('../../app/routes/entry.$headwordId.tsx');

  it('never reads the device dictionary cookie or the enrichment gate', () => {
    assert.doesNotMatch(ENTRY, /resolveWordEnrichmentPanel|isDeviceDictionaryDirection|device-dictionary/);
  });

  it('renders the section without an onRequest input, so it stays automatic', () => {
    assert.match(ENTRY, /<EnrichmentSection panel=\{panel\}/);
    assert.doesNotMatch(ENTRY, /onRequest/);
  });
});
