/**
 * The deferred translation pane (M208/03): while a device dictionary comes first,
 * the pane does not poll a `none` panel, a hit offers a button and never asks by
 * itself, and a miss asks by itself exactly once.
 *
 * THIS REPO HAS NO DOM LIBRARY, so the controller's rules live in pure functions in
 * `pane-state.ts` and are driven here without a browser, a timer or a network:
 * `isTranslationPaneAwaitingAsk`, `shouldTranslationPanePoll` and
 * `planDeferredAsk`. The hook and the screen are thin wiring over them, and the
 * last describe reads their source to prove the wiring is what these cases assume.
 *
 * THE FIVE STATES ARE ASSERTED TOO. The pane has exactly `ready`, `translating`,
 * `no-entry`, `budget` and `failed` (plus the `stalled` line of `translating`);
 * the deferred waiting is not a state of it, and nothing here adds one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { TranslationPanel } from '#app/lib/translation/panel.server';
import {
  deferredAskKey,
  initialTranslationPaneState,
  isTranslationPaneAwaitingAsk,
  planDeferredAsk,
  shouldTranslationPanePoll,
  translationPaneEndpoints,
  translationPaneReducer,
  translationPaneView,
  TRANSLATION_STALL_AFTER_MS,
  type DeferredAskInputs,
  type DeferredAskPlan,
  type DeviceLookupStatus,
} from '#app/lib/translation/pane-state';

const NONE: TranslationPanel = { state: 'none' };
const TRANSLATING: TranslationPanel = { state: 'translating' };
const READY: TranslationPanel = {
  state: 'ready',
  translations: [
    {
      translationId: 't1',
      lemma: 'Haus',
      pos: 'noun',
      confidence: 1,
      note: null,
      generated: false,
      up: 0,
      down: 0,
      myVote: null,
    },
  ],
};
const FAILED: TranslationPanel = { state: 'failed', canRetry: true, error: null };
const BUDGET: TranslationPanel = { state: 'budget', reason: 'daily-cap' };
const NO_ENTRY: TranslationPanel = { state: 'no-entry' };

const ALL_PANELS = [NONE, TRANSLATING, READY, FAILED, BUDGET, NO_ENTRY];
const ALL_LOOKUPS: DeviceLookupStatus[] = ['idle', 'loading', 'hit', 'miss'];

const KEY = deferredAskKey({ headwordId: 'h-1', from: 'en', to: 'de' });

/** Inputs for the plan, with the common case filled in. */
function inputs(overrides: Partial<DeferredAskInputs> = {}): DeferredAskInputs {
  return { isAwaitingAsk: true, lookup: 'miss', key: KEY, askedKey: null, isAsking: false, ...overrides };
}

describe('a deferred pane with a none panel does not poll', () => {
  it('is awaiting an ask only when deferred AND the panel is none', () => {
    for (const panel of ALL_PANELS) {
      const state = initialTranslationPaneState(panel);
      assert.equal(isTranslationPaneAwaitingAsk(state, true), panel.state === 'none', `deferred ${panel.state}`);
      assert.equal(isTranslationPaneAwaitingAsk(state, false), false, `undeferred ${panel.state}`);
    }
  });

  it('never polls a deferred none panel, however long it sits there', () => {
    let state = initialTranslationPaneState(NONE);
    assert.equal(shouldTranslationPanePoll(state, true), false);
    for (let tick = 0; tick < 100; tick += 1) state = translationPaneReducer(state, { type: 'tick' });
    assert.equal(shouldTranslationPanePoll(state, true), false);
    assert.equal(state.elapsedMs, 0, 'a none panel must not age');
  });

  it('does not let a poll answer replace the none panel', () => {
    const state = initialTranslationPaneState(NONE);
    assert.equal(translationPaneReducer(state, { type: 'polled', panel: NONE }), state);
    assert.equal(translationPaneReducer(state, { type: 'polled', panel: TRANSLATING }), state);
  });

  it('has no effect on any other panel: only translating polls, deferred or not', () => {
    for (const panel of ALL_PANELS) {
      const state = initialTranslationPaneState(panel);
      const expected = panel.state === 'translating';
      assert.equal(shouldTranslationPanePoll(state, true), expected, `deferred ${panel.state}`);
      assert.equal(shouldTranslationPanePoll(state, false), expected, `undeferred ${panel.state}`);
    }
  });

  it('stops polling a translating pane at the stall mark, deferred or not', () => {
    const stalled = { panel: TRANSLATING, elapsedMs: TRANSLATION_STALL_AFTER_MS };
    assert.equal(shouldTranslationPanePoll(stalled, true), false);
    assert.equal(shouldTranslationPanePoll(stalled, false), false);
  });

  it('hands over to the ordinary machine once an ask is adopted', () => {
    const asked = translationPaneReducer(initialTranslationPaneState(NONE), { type: 'adopted', panel: TRANSLATING });
    assert.equal(isTranslationPaneAwaitingAsk(asked, true), false);
    assert.equal(shouldTranslationPanePoll(asked, true), true, 'deferred must not stop a translating pane polling');
    assert.equal(translationPaneView(asked), 'translating');

    const refused = translationPaneReducer(initialTranslationPaneState(NONE), { type: 'adopted', panel: BUDGET });
    assert.equal(translationPaneView(refused), 'budget');
    assert.equal(shouldTranslationPanePoll(refused, true), false);
  });

  it('adds no pane state: a none panel still reads as one of the existing views', () => {
    const views = ALL_PANELS.map((panel) => translationPaneView(initialTranslationPaneState(panel)));
    assert.deepEqual(new Set(views), new Set(['no-entry', 'translating', 'ready', 'failed', 'budget']));
  });
});

describe('what the AI area does', () => {
  it('is inactive unless the pane is awaiting an ask for a real headword', () => {
    for (const lookup of ALL_LOOKUPS) {
      assert.equal(planDeferredAsk(inputs({ isAwaitingAsk: false, lookup })), 'inactive', lookup);
      assert.equal(planDeferredAsk(inputs({ key: null, lookup })), 'inactive', `no key, ${lookup}`);
    }
  });

  it('waits, drawing a neutral block, while the lookup runs', () => {
    assert.equal(planDeferredAsk(inputs({ lookup: 'loading' })), 'wait');
    assert.equal(planDeferredAsk(inputs({ lookup: 'loading', askedKey: KEY, isAsking: true })), 'wait');
  });

  it('NEVER asks by itself after a hit: it offers the button, whatever else is true', () => {
    for (const askedKey of [null, KEY, 'other']) {
      for (const isAsking of [false, true]) {
        const plan: DeferredAskPlan = planDeferredAsk(inputs({ lookup: 'hit', askedKey, isAsking }));
        assert.equal(plan, 'offer', `askedKey ${String(askedKey)}, isAsking ${String(isAsking)}`);
      }
    }
  });

  it('asks once after a miss, and treats a lookup that never ran as a miss', () => {
    assert.equal(planDeferredAsk(inputs({ lookup: 'miss' })), 'ask-now');
    assert.equal(planDeferredAsk(inputs({ lookup: 'idle' })), 'ask-now');
  });

  it('waits while that one ask is in flight, and offers the button if it did not take', () => {
    assert.equal(planDeferredAsk(inputs({ askedKey: KEY, isAsking: true })), 'wait');
    assert.equal(planDeferredAsk(inputs({ askedKey: KEY, isAsking: false })), 'offer');
  });

  it('is keyed on headword, language and direction, so another word asks again', () => {
    const other = deferredAskKey({ headwordId: 'h-2', from: 'en', to: 'de' });
    const reverse = deferredAskKey({ headwordId: 'h-1', from: 'de', to: 'en' });
    assert.equal(new Set([KEY, other, reverse]).size, 3);
    assert.equal(planDeferredAsk(inputs({ key: other, askedKey: KEY })), 'ask-now');
    assert.equal(planDeferredAsk(inputs({ key: reverse, askedKey: KEY })), 'ask-now');
  });
});

describe('the screen asks at most once per word, driven the way its effect drives it', () => {
  /** A stand-in for the screen: renders the plan, runs the effect, counts the posts. */
  function screen(lookup: DeviceLookupStatus) {
    let posts = 0;
    let askedKey: string | null = null;
    let autoAsked: string | null = null;
    let isAsking = false;
    let key = KEY;
    return {
      get posts() {
        return posts;
      },
      setKey(next: string) {
        key = next;
      },
      setAsking(next: boolean) {
        isAsking = next;
      },
      setLookup(next: DeviceLookupStatus) {
        lookup = next;
      },
      /** One render, then the effect the SearchPanes component runs after it. */
      render(): DeferredAskPlan {
        const plan = planDeferredAsk({ isAwaitingAsk: true, lookup, key, askedKey, isAsking });
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

  it('a miss posts exactly once however many times the screen re-renders', () => {
    const view = screen('miss');
    for (let render = 0; render < 10; render += 1) view.render();
    assert.equal(view.posts, 1);
  });

  it('a miss whose ask failed shows the button and does not post again', () => {
    const view = screen('miss');
    view.render();
    view.setAsking(false);
    assert.equal(view.render(), 'offer');
    assert.equal(view.render(), 'offer');
    assert.equal(view.posts, 1);
  });

  it('a hit never posts, over any number of renders', () => {
    const view = screen('hit');
    for (let render = 0; render < 10; render += 1) assert.equal(view.render(), 'offer');
    assert.equal(view.posts, 0);
  });

  it('waits for the lookup, then posts once if it settles to a miss', () => {
    const view = screen('loading');
    for (let render = 0; render < 3; render += 1) assert.equal(view.render(), 'wait');
    assert.equal(view.posts, 0);
    view.setLookup('miss');
    view.render();
    view.render();
    assert.equal(view.posts, 1);
  });

  it('posts once more for a different word', () => {
    const view = screen('miss');
    view.render();
    view.setAsking(false);
    view.setKey(deferredAskKey({ headwordId: 'h-2', from: 'en', to: 'de' }));
    view.render();
    view.render();
    assert.equal(view.posts, 2);
  });
});

describe('the wiring is what the cases above assume', () => {
  const PANE_SOURCE = readFileSync(new URL('../../app/components/translation-pane.tsx', import.meta.url), 'utf8');
  const PANES_SOURCE = readFileSync(new URL('../../app/components/search-panes.tsx', import.meta.url), 'utf8');

  it('ask and retry are ONE function: the same POST to the same gated retry route', () => {
    assert.match(PANE_SOURCE, /retry: postRetry,\s*ask: postRetry,/);
    assert.match(PANE_SOURCE, /fetcher\.submit\(null, \{ method: 'post', action: retryUrl \}\)/);
    const endpoints = translationPaneEndpoints({ kind: 'headword', headwordId: 'h-1', to: 'de' });
    assert.equal(endpoints?.retry, '/api/translation/h-1/retry?to=de');
  });

  it('the controller polls through the deferred-aware rule and defaults to not deferred', () => {
    assert.match(PANE_SOURCE, /shouldTranslationPanePoll\(state, deferred\)/);
    assert.match(PANE_SOURCE, /deferred = false,/);
    assert.doesNotMatch(PANE_SOURCE, /\bisTranslationPanePolling\(/, 'the controller bypasses the deferred rule');
  });

  it('the screen asks from an effect, behind a ref keyed on the plan and the headword key', () => {
    assert.match(PANES_SOURCE, /askPlan !== 'ask-now'/);
    assert.match(PANES_SOURCE, /autoAskedRef\.current === askKey/);
    assert.match(PANES_SOURCE, /autoAskedRef\.current = askKey;\s*setAskedKey\(askKey\);\s*translation\.ask\(\);/);
  });

  it('the only automatic caller of ask is that one effect', () => {
    const calls = [...PANES_SOURCE.matchAll(/translation\.ask\(/g)];
    assert.equal(calls.length, 1, 'ask() is called from more than one place in the screen');
  });
});
