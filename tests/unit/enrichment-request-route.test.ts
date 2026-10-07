/**
 * `POST /api/enrichment-request/:headwordId` (M209), the "Write the explanation"
 * button's half, driven through its real `action` and its real middleware.
 *
 * WHAT THIS HOLDS IN PLACE
 *   The button is the only thing that spends once a device dictionary comes first,
 *   so the route has to be exactly as guarded as a page load and no more open:
 *     1. A GET starts nothing (405, in JSON).
 *     2. A request with no session is turned away by the middleware with a 401 in
 *        JSON, before the action runs. The middleware is the REAL `authMiddleware`
 *        over a stubbed session read.
 *     3. A refusal by the rate limit or the budget is not an exception: it is the
 *        same panel with `refusal` set, and nothing is queued.
 *     4. An id that names no entry, a language outside the served four, and a
 *        missing or invalid `to` all answer the idle panel and spend nothing.
 *     5. A request that passes both guards queues exactly one job.
 *
 * THE READS ARE FAKED. `#drizzle/db` is stubbed so a read this file forgot to
 * fake fails loudly instead of opening a pool. The triggering resolver is the
 * REAL one, over faked cache, guard and queue modules, because "the same guarded
 * path" is the property under test and a faked resolver could not show it.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider, type MiddlewareFunction } from 'react-router';

import type { EnrichmentPanel } from '#app/lib/enrichment/state.server';

mock.module('#drizzle/db', {
  namedExports: {
    // The handle is handed to faked functions only and never dereferenced.
    getRawDb: () => ({}),
    db: {},
  },
});

mock.module('#app/services/session.server', {
  namedExports: {
    readUserSession: () => Promise.resolve(null),
    destroyUserSession: () => Promise.resolve('session=; Max-Age=0'),
    sessionStorage: { getSession: () => Promise.resolve({ get: () => ({ id: 7 }) }) },
  },
});

/** What the fakes answer, rewritten by each case. */
interface FakeWorld {
  resolved: { kind: 'found'; entity: 'headword' | 'sense'; id: string } | { kind: 'missing' };
  languageCode: string;
  headwordRows: number;
  rateLimitAllowed: boolean;
  budgetExhausted: boolean;
}

const world: FakeWorld = {
  resolved: { kind: 'found', entity: 'headword', id: 'h-1' },
  languageCode: 'en',
  headwordRows: 1,
  rateLimitAllowed: true,
  budgetExhausted: false,
};

/** Which reads and effects happened, in order. */
let calls: string[] = [];

mock.module('#app/lib/dictionary/queries.server', {
  namedExports: {
    createEntryLookups: () => ({}),
    resolveEntry: () => Promise.resolve(world.resolved),
  },
});

mock.module('#app/lib/dictionary/entry.server', {
  namedExports: {
    entryHeadwordQuery: () =>
      Promise.resolve(world.headwordRows === 0 ? [] : [{ headwordId: 'h-1', languageCode: world.languageCode }]),
    entrySensesQuery: () => Promise.resolve([{ senseId: 'sense-1' }]),
  },
});

mock.module('#app/models/app-settings.server', {
  namedExports: { getActiveModel: () => Promise.resolve({ provider: 'openrouter', model: 'a-model' }) },
});

mock.module('#app/lib/llm/registry.server', {
  namedExports: { registry: { describeConfiguration: () => ({ configured: true }) } },
});

mock.module('#app/models/enrichments.server', {
  namedExports: {
    listCachedEnrichments: () => Promise.resolve([]),
    latestAttempt: () => Promise.resolve(null),
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
      return Promise.resolve({ allowed: world.rateLimitAllowed });
    },
  },
});

mock.module('#app/lib/abuse/budget.server', {
  namedExports: {
    isBudgetExhausted: () => {
      calls.push('budget');
      return Promise.resolve(world.budgetExhausted);
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

const route = await import('#app/routes/api.enrichment-request.$headwordId');
const { authMiddleware } = await import('#app/middleware/auth');

/** A request to the route, as the button's fetcher makes it. */
function post(search = '?to=de', method = 'POST'): Request {
  return new Request(`https://kenning.altan.fyi/api/enrichment-request/h-1${search}`, { method });
}

/** The action's arguments, with only the two fields it reads. */
function args(request: Request): Parameters<typeof route.action>[0] {
  // SAFETY: the action reads `params` and `request` only. The generated `Route.ActionArgs`
  // type also carries a context provider and a pattern that this action never touches, and
  // building them for a unit test would only restate the framework.
  return { params: { headwordId: 'h-1' }, request } as never;
}

/** The panel a successful call answers. */
async function answer(request: Request): Promise<EnrichmentPanel> {
  const response = await route.action(args(request));
  assert.equal(response.status, 200);
  // SAFETY: every 200 this route sends is `Response.json(panel)` with an
  // `EnrichmentPanel`, including its three idle exits, and the assertions below
  // read `state`, `reason` and `refusal` only.
  return (await response.json()) as EnrichmentPanel;
}

beforeEach(() => {
  calls = [];
  world.resolved = { kind: 'found', entity: 'headword', id: 'h-1' };
  world.languageCode = 'en';
  world.headwordRows = 1;
  world.rateLimitAllowed = true;
  world.budgetExhausted = false;
});

describe('who may call it', () => {
  it('declares the account middleware, and it is the real one', () => {
    assert.deepEqual(route.middleware, [authMiddleware]);
  });

  it('turns a request with no session away with a 401 in JSON, before any action runs', async () => {
    const middleware: MiddlewareFunction = authMiddleware;
    const request = post();
    let refusal: Response | null = null;
    try {
      await middleware(
        { request, url: new URL(request.url), params: {}, pattern: '/api/enrichment-request/:headwordId', context: new RouterContextProvider() },
        () => Promise.resolve(new Response(null)),
      );
    } catch (cause) {
      if (!(cause instanceof Response)) throw cause;
      refusal = cause;
    }
    assert.ok(refusal, 'the middleware admitted a request with no session');
    assert.equal(refusal.status, 401);
    assert.match(refusal.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(calls, [], 'a refused request reached the guards');
  });
});

describe('what it refuses to start', () => {
  it('answers a GET with 405 and starts nothing', async () => {
    const thrown = await route.action(args(post('?to=de', 'GET'))).catch((cause: unknown) => cause);
    assert.ok(thrown instanceof Response);
    assert.equal(thrown.status, 405);
    assert.deepEqual(calls, []);
  });

  it('answers a PUT and a DELETE with 405 too', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const thrown = await route.action(args(post('?to=de', method))).catch((cause: unknown) => cause);
      assert.ok(thrown instanceof Response, method);
      assert.equal(thrown.status, 405, method);
    }
  });

  it('a missing or invalid `to` is the idle panel, and nothing is counted or queued', async () => {
    for (const search of ['', '?to=', '?to=xx', '?to=DE']) {
      const panel = await answer(post(search));
      assert.equal(panel.state, 'idle', search);
      assert.deepEqual(calls, [], search);
    }
  });

  it('an id that names no entry is the idle panel, not an error', async () => {
    world.resolved = { kind: 'missing' };
    const panel = await answer(post());
    assert.deepEqual(panel, { state: 'idle', reason: 'not-requested', model: null, from: null, senses: [] });
    assert.deepEqual(calls, []);
  });

  it('an id that names a sense, not a headword, is the idle panel', async () => {
    world.resolved = { kind: 'found', entity: 'sense', id: 's-1' };
    assert.equal((await answer(post())).state, 'idle');
    assert.deepEqual(calls, []);
  });

  it('a headword row that is gone is the idle panel', async () => {
    world.headwordRows = 0;
    assert.equal((await answer(post())).state, 'idle');
    assert.deepEqual(calls, []);
  });

  it('an entry outside the served four is the idle panel', async () => {
    world.languageCode = 'fr';
    assert.equal((await answer(post())).state, 'idle');
    assert.deepEqual(calls, []);
  });
});

describe('the same two guards a page load runs', () => {
  it('queues exactly one job when both guards let it through', async () => {
    const panel = await answer(post());

    assert.equal(panel.state, 'pending');
    assert.equal(panel.state === 'pending' ? panel.refusal : 'x', null);
    assert.deepEqual(calls, ['rateLimit', 'budget', 'enqueue']);
  });

  it('a rate-limited request is a 200 with the refusal set, and queues nothing', async () => {
    world.rateLimitAllowed = false;

    const panel = await answer(post());

    assert.equal(panel.state === 'pending' ? panel.refusal : null, 'rate-limited');
    assert.equal(calls.includes('enqueue'), false);
  });

  it('an exhausted budget is a 200 with the refusal set, and queues nothing', async () => {
    world.budgetExhausted = true;

    const panel = await answer(post());

    assert.equal(panel.state === 'pending' ? panel.refusal : null, 'budget');
    assert.deepEqual(calls, ['rateLimit', 'budget']);
  });
});
