/**
 * The enrichment card while the explanation waits for the reader (M209): what it
 * draws and when it asks, for each state of the device lookup, and that it asks
 * at most once per word.
 *
 * THIS REPO HAS NO DOM LIBRARY, so the decision lives in `request-plan.ts` and is
 * driven here without a browser, a timer or a network, the way
 * `device-dictionary-deferred-pane.test.ts` drives the translation pane's. The
 * section is thin wiring over it, and the last two describes read its source and
 * the search screen's to prove the wiring is what these cases assume.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { EnrichmentPanel } from '#app/lib/enrichment/state.server';
import {
  enrichmentRequestKey,
  isAwaitingEnrichmentRequest,
  planEnrichmentRequest,
  type EnrichmentOnRequest,
  type EnrichmentRequestInputs,
} from '#app/lib/enrichment/request-plan';
import type { DeferredAskPlan, DeviceLookupStatus } from '#app/lib/translation/pane-state';

const ON_REQUEST: EnrichmentPanel = { state: 'idle', reason: 'on-request', model: 'a-model', from: 'en', senses: [] };
const NOT_REQUESTED: EnrichmentPanel = { state: 'idle', reason: 'not-requested', model: null, from: 'en', senses: [] };
const NOT_CONFIGURED: EnrichmentPanel = {
  state: 'idle',
  reason: 'not-configured',
  model: 'a-model',
  from: 'en',
  senses: [],
};
const PENDING: EnrichmentPanel = {
  state: 'pending',
  reason: null,
  model: 'a-model',
  from: 'en',
  senses: [],
  refusal: null,
};
const REFUSED: EnrichmentPanel = { ...PENDING, refusal: 'rate-limited' };
const READY: EnrichmentPanel = { state: 'ready', reason: null, model: 'a-model', from: 'en', senses: [] };
const FAILED: EnrichmentPanel = {
  state: 'failed',
  reason: null,
  model: 'a-model',
  from: 'en',
  senses: [],
  retryable: false,
  refusal: null,
};

const ALL_LOOKUPS: DeviceLookupStatus[] = ['idle', 'loading', 'hit', 'miss'];
const KEY = enrichmentRequestKey({ headwordId: 'h-1', from: 'en', to: 'de' });

/** Inputs for the plan, with the common case filled in: a deferred card on a device miss. */
function inputs(overrides: Partial<EnrichmentRequestInputs> = {}): EnrichmentRequestInputs {
  return {
    panel: ON_REQUEST,
    headwordId: 'h-1',
    to: 'de',
    onRequest: { mode: 'deferred', lookup: 'miss' },
    askedKey: null,
    isAsking: false,
    ...overrides,
  };
}

/** A deferred mode over one lookup status. */
function deferred(lookup: DeviceLookupStatus): EnrichmentOnRequest {
  return { mode: 'deferred', lookup };
}

describe('which panels wait for a request', () => {
  it('only the idle panel with the reason on-request does', () => {
    assert.equal(isAwaitingEnrichmentRequest(ON_REQUEST), true);
    for (const panel of [NOT_REQUESTED, NOT_CONFIGURED, PENDING, REFUSED, READY, FAILED]) {
      assert.equal(isAwaitingEnrichmentRequest(panel), false, `${panel.state}`);
    }
  });

  it('every other panel leaves the card as it always was, whatever the lookup says', () => {
    for (const panel of [NOT_REQUESTED, NOT_CONFIGURED, PENDING, REFUSED, READY, FAILED]) {
      for (const lookup of ALL_LOOKUPS) {
        const plan = planEnrichmentRequest(inputs({ panel, onRequest: deferred(lookup) }));
        assert.equal(plan, 'inactive', `${panel.state} with lookup ${lookup}`);
      }
    }
  });

  it('is inactive when the panel names no language, because there is no key to ask under', () => {
    const panel: EnrichmentPanel = { ...ON_REQUEST, from: null };
    assert.equal(planEnrichmentRequest(inputs({ panel })), 'inactive');
  });
});

describe('what the card does for each lookup status', () => {
  it('waits, drawing a neutral block, while the device lookup runs', () => {
    assert.equal(planEnrichmentRequest(inputs({ onRequest: deferred('loading') })), 'wait');
    assert.equal(
      planEnrichmentRequest(inputs({ onRequest: deferred('loading'), askedKey: KEY, isAsking: true })),
      'wait',
    );
  });

  it('NEVER asks by itself after a hit: it offers the button, whatever else is true', () => {
    for (const askedKey of [null, KEY, 'other']) {
      for (const isAsking of [false, true]) {
        const plan: DeferredAskPlan = planEnrichmentRequest(inputs({ onRequest: deferred('hit'), askedKey, isAsking }));
        assert.equal(plan, 'offer', `askedKey ${String(askedKey)}, isAsking ${String(isAsking)}`);
      }
    }
  });

  it('asks once after a miss, and treats a lookup that never ran as a miss', () => {
    assert.equal(planEnrichmentRequest(inputs({ onRequest: deferred('miss') })), 'ask-now');
    assert.equal(planEnrichmentRequest(inputs({ onRequest: deferred('idle') })), 'ask-now');
  });

  it('waits while that one ask is in flight, and falls back to the button if it did not take', () => {
    assert.equal(planEnrichmentRequest(inputs({ askedKey: KEY, isAsking: true })), 'wait');
    assert.equal(planEnrichmentRequest(inputs({ askedKey: KEY, isAsking: false })), 'offer');
  });

  it('is keyed on headword, language and direction, so another word asks again', () => {
    const otherWord = enrichmentRequestKey({ headwordId: 'h-2', from: 'en', to: 'de' });
    const reverse = enrichmentRequestKey({ headwordId: 'h-1', from: 'de', to: 'en' });
    assert.equal(new Set([KEY, otherWord, reverse]).size, 3);
    assert.equal(planEnrichmentRequest(inputs({ headwordId: 'h-2', askedKey: KEY })), 'ask-now');
    assert.equal(planEnrichmentRequest(inputs({ panel: { ...ON_REQUEST, from: 'de' }, to: 'en', askedKey: KEY })), 'ask-now');
  });

  it('an automatic card never asks: if it ever meets an on-request panel it offers the button', () => {
    for (const askedKey of [null, KEY]) {
      assert.equal(planEnrichmentRequest(inputs({ onRequest: { mode: 'automatic' }, askedKey })), 'offer');
    }
  });
});

describe('the card asks at most once per word, driven the way its effect drives it', () => {
  /** A stand-in for the section: renders the plan, runs the effect, counts the posts. */
  function section(lookup: DeviceLookupStatus) {
    let posts = 0;
    let askedKey: string | null = null;
    let autoAsked: string | null = null;
    let isAsking = false;
    let headwordId = 'h-1';
    return {
      get posts() {
        return posts;
      },
      setHeadword(next: string) {
        headwordId = next;
      },
      setAsking(next: boolean) {
        isAsking = next;
      },
      setLookup(next: DeviceLookupStatus) {
        lookup = next;
      },
      /** One render, then the effect `EnrichmentSection` runs after it. */
      render(): DeferredAskPlan {
        const plan = planEnrichmentRequest(inputs({ headwordId, onRequest: deferred(lookup), askedKey, isAsking }));
        const key = enrichmentRequestKey({ headwordId, from: 'en', to: 'de' });
        if (plan === 'ask-now' && autoAsked !== key) {
          autoAsked = key;
          askedKey = key;
          posts += 1;
          isAsking = true;
        }
        return plan;
      },
    };
  }

  it('a miss posts exactly once however many times the section re-renders', () => {
    const view = section('miss');
    for (let render = 0; render < 10; render += 1) view.render();
    assert.equal(view.posts, 1);
  });

  it('a miss whose ask failed shows the button and does not post again', () => {
    const view = section('miss');
    view.render();
    view.setAsking(false);
    assert.equal(view.render(), 'offer');
    assert.equal(view.render(), 'offer');
    assert.equal(view.posts, 1);
  });

  it('a hit never posts, over any number of renders', () => {
    const view = section('hit');
    for (let render = 0; render < 10; render += 1) assert.equal(view.render(), 'offer');
    assert.equal(view.posts, 0);
  });

  it('waits for the lookup, then posts once if it settles to a miss', () => {
    const view = section('loading');
    for (let render = 0; render < 3; render += 1) assert.equal(view.render(), 'wait');
    assert.equal(view.posts, 0);
    view.setLookup('miss');
    view.render();
    view.render();
    assert.equal(view.posts, 1);
  });

  it('posts once more for a different word', () => {
    const view = section('miss');
    view.render();
    view.setAsking(false);
    view.setHeadword('h-2');
    view.render();
    view.render();
    assert.equal(view.posts, 2);
  });
});

/** A file as text, with block comments removed, for the questions below that must ignore prose. */
function readCode(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the section is wired the way the cases above assume', () => {
  const SECTION = readCode('../../app/components/enrichment-section.tsx');

  it('decides through planEnrichmentRequest and posts to the request route on its own fetcher', () => {
    assert.match(SECTION, /planEnrichmentRequest\(\{/);
    assert.match(SECTION, /`\/api\/enrichment-request\/\$\{headwordId\}\?to=\$\{to\}`/);
    assert.match(SECTION, /autoAskedRef\.current === requestKey/);
    assert.equal([...SECTION.matchAll(/useFetcher</g)].length, 2, 'the poll and the request must not share a fetcher');
  });

  it('polls only a pending panel with no refusal: waiting for a request never polls', () => {
    assert.match(SECTION, /const isPolling = shown\.state === 'pending' && shown\.refusal === null && !isExhausted;/);
  });

  it('draws no skeleton while waiting: the request card is not the pending card', () => {
    const start = SECTION.indexOf('function RequestPanel');
    const end = SECTION.indexOf('function PendingPanel');
    assert.ok(start > -1 && end > start, 'RequestPanel or PendingPanel moved');
    assert.doesNotMatch(SECTION.slice(start, end), /Skeleton|animate-pulse|pulse-soft|loading-dots/);
  });

  it('is the default for every caller that passes no onRequest, including the entry page', () => {
    assert.match(SECTION, /onRequest = AUTOMATIC/);
    assert.match(SECTION, /const AUTOMATIC: EnrichmentOnRequest = \{ mode: 'automatic' \};/);
  });

  it('imports nothing from the device dictionary engine, which only three files may', () => {
    assert.doesNotMatch(SECTION, /local-dictionary/);
  });
});

describe('the search screen passes the lookup it already has', () => {
  const PANES = readCode('../../app/components/search-panes.tsx');

  it('hands the section deferred and the lookup status when the loader deferred, automatic otherwise', () => {
    assert.match(
      PANES,
      /onRequest=\{deviceDictionary \? \{ mode: 'deferred', lookup: deviceLookup\.status \} : \{ mode: 'automatic' \}\}/,
    );
  });

  it('calls the lookup hook once, so the section and the translation area read one answer', () => {
    assert.equal([...PANES.matchAll(/useDeviceDictionaryHit\(/g)].length, 1);
  });

  it('keys the section on the word and the direction, so one word never reads another one answer', () => {
    assert.match(PANES, /<EnrichmentSection\s+key=\{`\$\{translationHeadwordId\}:\$\{direction\.from\}:\$\{direction\.to\}`\}/);
  });
});
