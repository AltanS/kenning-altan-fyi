/**
 * The loader gate for the device dictionary (M208/03): with the `device-dict`
 * cookie listing the direction, a single-word search reads the translation panel
 * and queues NOTHING; without it, the search path is the one it always was.
 *
 * WHAT THIS HOLDS IN PLACE, AND WHY IT IS A TEST AND NOT A COMMENT
 *   The reason for the whole feature is money. A word the corpus has never
 *   translated used to queue a paid model call the moment it was searched. A
 *   reader who has brought their own dictionary should not pay for that until
 *   they say so. Three things keep the promise, and each is asserted here:
 *     1. The decision. Cookie set means the read-only resolver; cookie absent
 *        means the triggering resolver, untouched.
 *     2. The effect. Run through the REAL `panel.server` resolvers over faked
 *        reads, a deferred `none` calls no budget check, no rate limit and no
 *        enqueue, and an undeferred one still does. Asserting only the decision
 *        would pass on a loader that chose right and then called both anyway.
 *     3. The wiring. A phrase never reads the cookie, every loader return carries
 *        the flag, and the enrichment panel is not deferred. The loader needs a
 *        database to run, so this reads its source, the way
 *        `phrase-branch-routes-to-search-phrase.test.ts` does.
 *
 * THE READS ARE FAKED THE WAY `translation-panel-gate.test.ts` FAKES THEM, and
 * for the same reason: `#drizzle/db` connects at module load, so it is stubbed to
 * throw, and a read this file forgot to fake fails loudly instead of hanging.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { TranslationRow } from '#app/lib/translation/translations-query.server';
import type { TranslationRunView } from '#app/models/translation-runs.server';

mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      throw new Error('the unit tier must not reach a database');
    },
  },
});

/** What the fakes below answer, rewritten by each case. */
interface FakeReads {
  translations: TranslationRow[];
  run: TranslationRunView | null;
}

const fake: FakeReads = { translations: [], run: null };

/** Which reads happened, in order. */
let calls: string[] = [];

mock.module('#app/lib/translation/translations-query.server', {
  namedExports: {
    listTranslationsInto: () => {
      calls.push('translations');
      return Promise.resolve(fake.translations);
    },
  },
});

mock.module('#app/models/translation-runs.server', {
  namedExports: {
    latestRun: () => {
      calls.push('latestRun');
      return Promise.resolve(fake.run);
    },
    countRunsToday: () => {
      calls.push('countRunsToday');
      return Promise.resolve(0);
    },
  },
});

mock.module('#app/lib/abuse/rate-limit.server', {
  namedExports: {
    checkTriggerRateLimit: () => {
      calls.push('rateLimit');
      return Promise.resolve({ allowed: true });
    },
  },
});

mock.module('#app/lib/abuse/budget.server', {
  namedExports: {
    isBudgetExhausted: () => {
      calls.push('budget');
      return Promise.resolve(false);
    },
  },
});

mock.module('#app/lib/translation/enqueue.server', {
  namedExports: {
    enqueueTranslation: () => {
      calls.push('enqueue');
      return Promise.resolve({ outcome: 'queued', runId: 'run-1' });
    },
  },
});

const { resolveTranslationPanel, resolveTriggeredTranslationPanel } = await import('#app/lib/translation/panel.server');
const { isDeviceDictionaryDirection, resolveWordTranslationPanel } =
  await import('#app/lib/translation/device-dictionary-gate');
const { DEVICE_DICTIONARY_COOKIE } = await import('#app/lib/dictionary/device-dictionary-cookie');

// SAFETY: every read the resolvers perform is faked above, so the handle is passed
// along and never dereferenced. Any fake that did touch it would fail on the first
// property access rather than silently querying.
/** The database handle every resolver takes and no fake reads. */
const db = {} as never;

const key = { headwordId: '99a991dc-8e80-4b65-82e5-effbbaf84269', from: 'en', to: 'de' } as const;
const request = new Request('https://kenning.altan.fyi/?q=house');

/** One translation row, as the corpus read returns it. */
function row(overrides: Partial<TranslationRow> = {}): TranslationRow {
  return {
    translationId: 'b0f1c8a4-2f52-4a1a-9f3d-1c2b3a4d5e6f',
    lemma: 'Haus',
    pos: 'noun',
    confidence: 0.9,
    note: null,
    generated: false,
    up: 0,
    down: 0,
    myVote: null,
    ...overrides,
  };
}

/** One run row with only the fields the resolver reads filled in. */
function run(status: TranslationRunView['status']): TranslationRunView {
  return {
    id: 'run-0',
    headwordId: key.headwordId,
    from: key.from,
    to: key.to,
    promptVersion: 1,
    provider: 'openrouter',
    model: 'a-model',
    status,
    output: null,
    written: null,
    capped: false,
    error: null,
    costUsd: null,
    latencyMs: null,
    createdAt: new Date('2026-10-07T10:00:00.000Z'),
    finishedAt: null,
    retractedAt: null,
  };
}

/** The panel the loader would put in its data, chosen the way the loader chooses it. */
function loaderPanel(isDeferred: boolean) {
  return resolveWordTranslationPanel({
    isDeferred,
    read: () => resolveTranslationPanel(db, key),
    trigger: () => resolveTriggeredTranslationPanel(db, { ...key, request }),
  });
}

beforeEach(() => {
  calls = [];
  fake.translations = [];
  fake.run = null;
});

describe('which cookie makes a direction deferred', () => {
  it('is true when the cookie lists exactly this direction', () => {
    const header = `theme=dark; ${DEVICE_DICTIONARY_COOKIE}=de-en,en-de; other=1`;
    assert.equal(isDeviceDictionaryDirection({ cookieHeader: header, from: 'en', to: 'de' }), true);
    assert.equal(isDeviceDictionaryDirection({ cookieHeader: header, from: 'de', to: 'en' }), true);
  });

  it('is false for the other direction: a dictionary answers one way only', () => {
    const header = `${DEVICE_DICTIONARY_COOKIE}=en-de`;
    assert.equal(isDeviceDictionaryDirection({ cookieHeader: header, from: 'de', to: 'en' }), false);
    assert.equal(isDeviceDictionaryDirection({ cookieHeader: header, from: 'en', to: 'tr' }), false);
  });

  it('is false with no cookie, an empty cookie and a cookie of nonsense', () => {
    assert.equal(isDeviceDictionaryDirection({ cookieHeader: null, from: 'en', to: 'de' }), false);
    assert.equal(
      isDeviceDictionaryDirection({ cookieHeader: `${DEVICE_DICTIONARY_COOKIE}=`, from: 'en', to: 'de' }),
      false,
    );
    assert.equal(
      isDeviceDictionaryDirection({
        cookieHeader: `${DEVICE_DICTIONARY_COOKIE}=EN-DE,en-en,%zz`,
        from: 'en',
        to: 'de',
      }),
      false,
    );
  });
});

describe('the choice between the two resolvers', () => {
  it('calls only the read-only resolver when deferred, and only the trigger when not', async () => {
    const called: string[] = [];
    const resolvers = {
      read: () => {
        called.push('read');
        return Promise.resolve({ state: 'none' } as const);
      },
      trigger: () => {
        called.push('trigger');
        return Promise.resolve({ state: 'translating' } as const);
      },
    };

    assert.deepEqual(await resolveWordTranslationPanel({ ...resolvers, isDeferred: true }), { state: 'none' });
    assert.deepEqual(called, ['read']);

    called.length = 0;
    assert.deepEqual(await resolveWordTranslationPanel({ ...resolvers, isDeferred: false }), { state: 'translating' });
    assert.deepEqual(called, ['trigger']);
  });
});

describe('a stored budget row does not stick for a deferred reader', () => {
  const BUDGET = { state: 'budget', reason: 'daily-cap' } as const;
  const FAILED = { state: 'failed', canRetry: true, error: null } as const;

  it('deferred and read() returns budget: the panel is none, so the ask can re-run the guards', async () => {
    const panel = await resolveWordTranslationPanel({
      isDeferred: true,
      read: () => Promise.resolve(BUDGET),
      trigger: () => Promise.reject(new Error('trigger must not run when deferred')),
    });
    assert.deepEqual(panel, { state: 'none' });
  });

  it('deferred and read() returns failed: it stays failed', async () => {
    const panel = await resolveWordTranslationPanel({
      isDeferred: true,
      read: () => Promise.resolve(FAILED),
      trigger: () => Promise.reject(new Error('trigger must not run when deferred')),
    });
    assert.deepEqual(panel, FAILED);
  });

  it('not deferred: whatever trigger() returns, budget included, and read() is never called', async () => {
    const panel = await resolveWordTranslationPanel({
      isDeferred: false,
      read: () => Promise.reject(new Error('read must not run when not deferred')),
      trigger: () => Promise.resolve(BUDGET),
    });
    assert.deepEqual(panel, BUDGET);
  });

  it('through the real read half: a stored budget run becomes none and queues nothing', async () => {
    fake.run = run('budget');
    assert.deepEqual(await loaderPanel(true), { state: 'none' });
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.includes('rateLimit'), false);
  });
});

describe('what the real resolvers do under each choice', () => {
  it('cookie set and a pair nobody has translated: the panel is none and NOTHING is queued or spent', async () => {
    const panel = await loaderPanel(true);

    assert.deepEqual(panel, { state: 'none' });
    assert.deepEqual(calls, ['translations', 'latestRun']);
    for (const spend of ['enqueue', 'rateLimit', 'budget', 'countRunsToday']) {
      assert.equal(calls.includes(spend), false, `a deferred search touched "${spend}"`);
    }
  });

  it('cookie absent: the same pair still queues, behind the three guards, exactly as before', async () => {
    const panel = await loaderPanel(false);

    assert.deepEqual(panel, { state: 'translating' });
    assert.deepEqual(calls, ['translations', 'latestRun', 'budget', 'countRunsToday', 'rateLimit', 'enqueue']);
  });

  it('cookie set and a stored translation: it still wins and shows', async () => {
    fake.translations = [row()];

    const panel = await loaderPanel(true);

    assert.equal(panel.state, 'ready');
    assert.deepEqual(calls, ['translations']);
  });

  it('cookie set and an open or failed run: those panels are reported, not replaced by none', async () => {
    fake.run = run('pending');
    assert.deepEqual(await loaderPanel(true), { state: 'translating' });

    fake.run = run('failed');
    assert.equal((await loaderPanel(true)).state, 'failed');
    assert.equal(calls.includes('enqueue'), false);
  });
});

/** The loader, as text. Read once, questioned below. */
const ROUTE_SOURCE = readFileSync(new URL('../../app/routes/translate.tsx', import.meta.url), 'utf8');

/** The body of the loader's phrase branch, matched by shape the way the phrase-branch test does. */
function phraseBranchBody(): string {
  const match = /if \(\w+\.isPhrase\) \{([\s\S]*?)\n {2}\}/.exec(ROUTE_SOURCE);
  assert.ok(match, 'translate.tsx has no `if (<query>.isPhrase) { ... }` branch in its loader.');
  return match[1] ?? '';
}

describe('the loader wires the gate into the single-word branch only', () => {
  it('a phrase never reads the cookie, and says so in its return', () => {
    const body = phraseBranchBody();
    assert.doesNotMatch(
      body,
      /isDeviceDictionaryDirection|parseDeviceDictionaryCookie|cookieHeader|resolveWordTranslationPanel/,
      'the phrase branch reads the device dictionary cookie. A phrase never uses it.',
    );
    assert.match(body, /deviceDictionary: false,/);
  });

  it('reads the cookie after the phrase branch has closed', () => {
    const phrase = /if \(\w+\.isPhrase\) \{[\s\S]*?\n {2}\}/.exec(ROUTE_SOURCE);
    assert.ok(phrase, 'no phrase branch');
    const readAt = ROUTE_SOURCE.indexOf('isDeviceDictionaryDirection({');
    assert.ok(readAt > -1, 'the loader no longer reads the device dictionary cookie');
    assert.ok(readAt > phrase.index + phrase[0].length, 'the cookie is read before the phrase branch has returned');
  });

  it('puts deviceDictionary in EVERY loader return: landing, phrase and word', () => {
    const loaderSource = ROUTE_SOURCE.slice(
      ROUTE_SOURCE.indexOf('export async function loader'),
      ROUTE_SOURCE.indexOf('function paneTarget'),
    );
    const returns = [...loaderSource.matchAll(/\n {2,6}return \{/g)];
    const flags = [...loaderSource.matchAll(/\n {2,6}deviceDictionary(?:: false)?,/g)];
    assert.equal(returns.length, 3, 'the loader no longer has exactly three object returns');
    assert.equal(flags.length, returns.length, 'a loader return is missing the deviceDictionary flag');
    assert.equal(
      [...loaderSource.matchAll(/deviceDictionary: false,/g)].length,
      2,
      'landing and phrase must say false',
    );
  });

  it('routes the word panel through the gate and keeps the trigger call as the cookie-less path', () => {
    assert.match(ROUTE_SOURCE, /resolveWordTranslationPanel\(\{\s*isDeferred: deviceDictionary,/);
    assert.match(ROUTE_SOURCE, /trigger: \(\) =>\s*resolveTriggeredTranslationPanel\(db, \{\s*request,/);
    assert.match(ROUTE_SOURCE, /read: \(\) =>\s*resolveTranslationPanel\(db, \{/);
  });

  it('defers the enrichment panel through its own gate, from the same flag (M209)', () => {
    // This case used to assert the opposite, "leaves the enrichment panel
    // un-deferred", when the explanation job was a follow-up. M209 deferred it,
    // through `resolveWordEnrichmentPanel` and not through the translation gate;
    // `enrichment-device-dictionary-gate.test.ts` holds the rest of that wiring.
    assert.match(ROUTE_SOURCE, /resolveWordEnrichmentPanel\(\{\s*isDeferred: deviceDictionary,/);
  });

  it('defers the controller from the same flag the loader returned', () => {
    assert.match(ROUTE_SOURCE, /deferred: deviceDictionary,/);
  });
});
