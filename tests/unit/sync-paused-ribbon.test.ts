/**
 * The "sync is paused" ribbon: which state it is in, where its sign-in link
 * goes, what it draws, and what its erase button does.
 *
 * The CHOICE of state is a pure function (`resolvePausedRibbon`), so the quiet
 * cases are checked as data: no hint, no pause, offline, a fallback root answer
 * and a matching account must all draw nothing. The drawing is checked through
 * `react-dom/server`, as `install-app.test.ts` does, because this repo has no DOM
 * library; `SyncPausedRibbonView` is the presentational half, split out so a
 * fixed state can be rendered. `Link` needs a router, so the view renders inside
 * a `createRoutesStub`.
 *
 * DESIGN.md section 0 is checked on the markup itself: no thick left border and
 * no dismiss control, and the row is the same square-cornered `output` the update
 * ribbon is.
 */
import { createElement } from 'react';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { createRoutesStub } from 'react-router';
import { createInstance } from 'i18next';

import { SyncPausedRibbonView } from '#app/components/sync-paused-ribbon';
import { SIGNED_IN_HINT_KEY, readSignedInHint, replaceSignedInHint, setSyncPause } from '#app/lib/auth/signed-in-hint';
import { eraseOtherAccountData } from '#app/lib/sync/erase-other-account';
import { resolvePausedRibbon, signInHref, type PausedRibbonState } from '#app/lib/sync/paused-ribbon-state';
import { createMemoryStorage, createSyncStateStore } from '#app/lib/sync/sync-state';
import { clearSyncSession, getSyncSession, setSyncSession } from '#app/lib/sync/sync-session';
import enCommon from '#app/locales/en/common.json';

const EXPIRED_HINT = { userId: 5, pause: { reason: 'expired', at: 1 } } as const;
const OTHER_HINT = { userId: 5, pause: { reason: 'other-account', at: 1 } } as const;

describe('resolvePausedRibbon', () => {
  const live = { isOnline: true, rootUserId: 5, isOfflineFallback: false };

  it('says nothing without a hint or without a pause', () => {
    assert.deepEqual(resolvePausedRibbon({ ...live, hint: null }), { kind: 'none' });
    assert.deepEqual(resolvePausedRibbon({ ...live, hint: { userId: 5 } }), { kind: 'none' });
  });

  it('offers the sign-in link for an expired pause while online', () => {
    assert.deepEqual(resolvePausedRibbon({ ...live, hint: EXPIRED_HINT, rootUserId: null }), { kind: 'expired' });
  });

  it('stays quiet about an expired pause while offline, where there is no sign-in to do', () => {
    assert.deepEqual(resolvePausedRibbon({ ...live, isOnline: false, hint: EXPIRED_HINT }), { kind: 'none' });
  });

  it('offers the erase for an other-account pause when a LIVE root names a different account', () => {
    assert.deepEqual(resolvePausedRibbon({ ...live, hint: OTHER_HINT, rootUserId: 9 }), {
      kind: 'other-account',
      hintUserId: 5,
      rootUserId: 9,
    });
  });

  it('never offers the erase on an offline fallback answer, which is built from the hint', () => {
    assert.deepEqual(resolvePausedRibbon({ ...live, hint: OTHER_HINT, rootUserId: 9, isOfflineFallback: true }), {
      kind: 'none',
    });
  });

  it('never offers the erase when the root names nobody or the hint account itself', () => {
    assert.deepEqual(resolvePausedRibbon({ ...live, hint: OTHER_HINT, rootUserId: null }), { kind: 'none' });
    assert.deepEqual(resolvePausedRibbon({ ...live, hint: OTHER_HINT, rootUserId: 5 }), { kind: 'none' });
  });
});

describe('signInHref', () => {
  it('carries the screen the reader is on, path and query, as an encoded next', () => {
    assert.equal(signInHref({ pathname: '/lists', search: '?tab=due' }), '/sign-in?next=%2Flists%3Ftab%3Ddue');
    assert.equal(signInHref({ pathname: '/', search: '' }), '/sign-in?next=%2F');
  });

  it('on /offline uses the offline page own next parameter', () => {
    assert.equal(
      signInHref({ pathname: '/offline', search: '?next=%2Fentry%2F7' }),
      '/sign-in?next=%2Fentry%2F7',
    );
  });

  it('on /offline falls back to / when next is missing, absolute or protocol-relative', () => {
    const home = '/sign-in?next=%2F';
    assert.equal(signInHref({ pathname: '/offline', search: '' }), home);
    assert.equal(signInHref({ pathname: '/offline', search: '?next=https%3A%2F%2Fevil.example' }), home);
    assert.equal(signInHref({ pathname: '/offline', search: '?next=%2F%2Fevil.example' }), home);
    assert.equal(signInHref({ pathname: '/offline', search: '?next=%2Foffline' }), home);
  });
});

/** The English catalogue in a bare i18next instance. */
function englishInstance() {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: enCommon } },
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
  });
  return instance;
}

/** The view rendered for one fixed state, as static markup. */
function renderRibbon(state: PausedRibbonState, erasePhase: 'idle' | 'erasing' | 'blocked' = 'idle'): string {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: () =>
        createElement(SyncPausedRibbonView, {
          state,
          signInHref: '/sign-in?next=%2Flists',
          erasePhase,
          onErase: () => undefined,
        }),
    },
  ]);
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n: englishInstance() }, createElement(Stub, { initialEntries: ['/'] })),
  );
}

describe('the ribbon markup', () => {
  it('draws nothing for none', () => {
    assert.equal(renderRibbon({ kind: 'none' }), '');
  });

  it('expired: the sentence and a sign-in link to the current screen, and no button', () => {
    const markup = renderRibbon({ kind: 'expired' });
    assert.ok(markup.includes(enCommon.sync.pausedExpired), markup);
    assert.ok(markup.includes(enCommon.sync.pausedExpiredAction), markup);
    assert.ok(markup.includes('href="/sign-in?next=%2Flists"'), markup);
    assert.ok(!markup.includes('<button'), 'the expired state has a link, not a button');
  });

  it('other account: the sentence and an Erase it button, and no sign-in link', () => {
    const markup = renderRibbon({ kind: 'other-account', hintUserId: 5, rootUserId: 9 });
    // The markup escapes the apostrophe, so compare against the escaped sentence.
    assert.ok(markup.includes(enCommon.sync.pausedOtherAccount.replace("'", '&#x27;')), markup);
    assert.ok(markup.includes(enCommon.sync.eraseOtherAccountAction), markup);
    assert.ok(markup.includes('<button'), markup);
    assert.ok(!markup.includes('href='), 'the other-account state offers no sign-in link');
  });

  it('follows the UpdateRibbon idiom: an in-flow output row, square, with no left accent and no dismiss', () => {
    for (const state of [{ kind: 'expired' }, { kind: 'other-account', hintUserId: 5, rootUserId: 9 }] as const) {
      const markup = renderRibbon(state);
      assert.ok(markup.startsWith('<output'), markup);
      const rootTag = markup.slice(0, markup.indexOf('>'));
      assert.ok(rootTag.includes('border-b'), 'a bottom border');
      assert.ok(!/rounded/.test(rootTag), 'square corners on the row');
      assert.ok(!/border-l|border-left/.test(markup), 'no left accent border');
      assert.ok(!/fixed|absolute|animate-/.test(rootTag), 'in flow, no animation');
      assert.ok(!/aria-label="[^"]*(close|dismiss)/i.test(markup), 'no dismiss control');
      assert.ok(markup.includes('aria-hidden="true"'), 'the icon is hidden from assistive tech');
    }
  });
});

/** A hint for user 5 with an other-account pause, and a stub `localStorage` holding it. */
function setUp() {
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
  replaceSignedInHint(5);
  setSyncPause('other-account');
  const syncStateStorage = createMemoryStorage();
  createSyncStateStore({ storage: syncStateStorage, userId: 5 }).save({
    formatVersion: 1,
    lastBlobVersion: 12,
    lastSyncedAt: 100,
  });
  setSyncSession({ userId: 5 });
  return { stored, syncStateStorage };
}

function tearDown(): void {
  clearSyncSession();
  Reflect.deleteProperty(globalThis, 'localStorage');
}

const BOTH = ['translate-primary', 'translate-outbox'];

describe('eraseOtherAccountData', () => {
  it('wipes, forgets the old sync state, hands the hint to the new account and drops the session', async () => {
    const { syncStateStorage } = setUp();
    try {
      const outcome = await eraseOtherAccountData({
        oldUserId: 5,
        newUserId: 9,
        wipe: () => Promise.resolve(BOTH),
        syncStateStorage,
      });
      assert.equal(outcome, 'erased');
      assert.deepEqual(readSignedInHint(), { userId: 9 });
      assert.equal(createSyncStateStore({ storage: syncStateStorage, userId: 5 }).load().lastBlobVersion, 0);
      assert.equal(getSyncSession(), null);
    } finally {
      tearDown();
    }
  });

  it('stops with the hint and the sync state unchanged when fewer than two databases went', async () => {
    const { stored, syncStateStorage } = setUp();
    try {
      const before = stored.get(SIGNED_IN_HINT_KEY);
      for (const deleted of [[], ['translate-primary'], ['translate-outbox']]) {
        const outcome = await eraseOtherAccountData({
          oldUserId: 5,
          newUserId: 9,
          wipe: () => Promise.resolve(deleted),
          syncStateStorage,
        });
        assert.equal(outcome, 'blocked', JSON.stringify(deleted));
        assert.equal(stored.get(SIGNED_IN_HINT_KEY), before, 'the hint must not change');
        assert.equal(createSyncStateStore({ storage: syncStateStorage, userId: 5 }).load().lastBlobVersion, 12);
      }
    } finally {
      tearDown();
    }
  });
});
