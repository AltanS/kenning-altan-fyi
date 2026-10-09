#!/usr/bin/env node
// Airplane-mode check for the Kenning PWA. See README.md in this folder.
//
//   node scripts/offline-check/run.mjs [--only S1,S3] [--keep-app] [--no-app]
//
// It starts the PRODUCTION build on 127.0.0.1, puts a fault-injection proxy in
// front of it, and drives a fresh Chromium profile per scenario over CDP. Every
// scenario asserts that the page is INTERACTIVE (hydrated, typeable), not just
// painted. On a FAIL it writes evidence under out/<timestamp>/<scenario>/.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Browser, sleep } from './cdp.mjs';
import { createProxy } from './proxy.mjs';
import { startApp } from './app.mjs';

const here = new URL('.', import.meta.url).pathname;
const APP_PORT = Number(process.env.OFFLINE_CHECK_APP_PORT ?? 3777);
const PROXY_PORT = Number(process.env.OFFLINE_CHECK_PORT ?? 3778);
const DB_NAME = process.env.OFFLINE_CHECK_DB ?? 'kenning_offline_check';
const ORIGIN = `http://localhost:${PROXY_PORT}`;
const EMAIL = 'offline-check@example.test';
const PASSWORD = 'offline-check-password-1';
const CHROME =
  process.env.CHROME_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const useExistingApp = args.includes('--no-app');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(here, 'out', stamp);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Page-side snippets
// ---------------------------------------------------------------------------

/** True when the search box exists AND React has attached to it. */
const HYDRATED_SEARCH_BOX = `(() => {
  const ta = document.querySelector('textarea');
  return !!ta && Object.keys(ta).some((k) => k.startsWith('__reactProps$'));
})()`;

/** True when the element exists AND React has attached to it. */
const hydrated = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
})()`;

const SW_STATE = `(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  const c = navigator.serviceWorker.controller;
  return {
    onLine: navigator.onLine,
    controller: c ? { scriptURL: c.scriptURL.replace(location.origin, ''), state: c.state } : null,
    registrations: regs.map((r) => ({
      scope: r.scope.replace(location.origin, ''),
      active: r.active ? r.active.state : null,
      installing: r.installing ? r.installing.state : null,
      waiting: r.waiting ? r.waiting.state : null,
    })),
  };
})()`;

/** Every cache, its entries, and which of the cached shell's assets are missing. */
const CACHE_STATE = `(async () => {
  const names = await caches.keys();
  const out = { caches: {}, shell: null };
  for (const name of names) {
    const cache = await caches.open(name);
    out.caches[name] = (await cache.keys()).map((r) => r.url.replace(location.origin, ''));
  }
  const root = await caches.match('/');
  if (root) {
    const html = await root.text();
    const assets = [...new Set([...html.matchAll(/\\/assets\\/[A-Za-z0-9._-]+\\.(?:js|css)/g)].map((m) => m[0]))];
    const have = new Set(Object.values(out.caches).flat());
    out.shell = {
      htmlBytes: html.length,
      assetsReferenced: assets.length,
      assetsMissingFromCaches: assets.filter((a) => !have.has(a)),
    };
  }
  return out;
})()`;

const FAKE_DICTIONARY = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('kenning-device-dictionary', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'pair' });
      r.result.createObjectStore('entries', { keyPath: ['pair', 'key'] });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'entries'], 'readwrite');
    tx.objectStore('entries').put({ pair: 'de-en', key: 'haus', written: 'Haus', translations: ['house', 'home'], score: 100 });
    tx.objectStore('meta').put({ pair: 'de-en', from: 'de', to: 'en', entryCount: 1, importedAt: Date.now(), sourceName: 'WikDict', sourceLicence: 'CC BY-SA 4.0' });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  document.cookie = 'device-dict=de-en; Path=/; Max-Age=31536000; SameSite=Lax';
  return true;
})()`;

const ERROR_TEXT = /Oops!|An unexpected error occurred|The requested page could not be found/;
const OFFLINE_NOTICE = /connection|offline|internet/i;

// ---------------------------------------------------------------------------
// Context: one browser profile + the shared proxy
// ---------------------------------------------------------------------------

class Ctx {
  constructor(id, proxy) {
    this.id = id;
    this.proxy = proxy;
    this.dir = join(outDir, id);
    mkdirSync(this.dir, { recursive: true });
    this.browser = null;
    this.page = null;
    this.notes = [];
    this.cachesBeforeOffline = null;
    this.evidenceCount = 0;
  }

  note(text) {
    this.notes.push(text);
  }

  async start() {
    this.proxy.setMode('online');
    this.browser = await Browser.launch({ chromePath: CHROME });
    this.page = await this.browser.newPage();
  }

  async stop() {
    await this.page?.close().catch(() => {});
    await this.browser?.stop();
    this.proxy.setMode('online');
  }

  async goOffline() {
    this.cachesBeforeOffline = (await this.page.eval(CACHE_STATE)).value ?? null;
    this.proxy.setMode('offline');
    await this.browser.setOffline(true);
    // Negative control: a fetch the worker does not intercept (it has a query
    // string) must now fail. If it succeeds, the harness is not offline and
    // every PASS below would be meaningless.
    if ((await this.page.url()).startsWith(ORIGIN)) {
      const probe = await this.page.eval(
        `fetch('/healthcheck?oc=' + Date.now(), { cache: 'no-store' }).then(() => 'reachable', () => 'blocked')`,
      );
      if (probe.value !== 'blocked') throw new Error(`HARNESS: the network is still reachable after going offline (${probe.value ?? probe.error})`);
    }
  }

  async goOnline() {
    this.proxy.setMode('online');
    await this.browser.setOffline(false);
  }

  /**
   * Closes the tab and restarts the whole browser process on the same profile.
   * Options are `restart()`'s: `restoreCookies` and `dropCookies` (see cdp.mjs).
   * Returns what the restart did with the cookies.
   */
  async coldStart(options = {}) {
    await this.page.close().catch(() => {});
    const done = await this.browser.restart(options);
    this.page = await this.browser.newPage();
    return done;
  }

  /** Everything that helps explain a failure. */
  async evidence(label, extra = {}) {
    const n = ++this.evidenceCount;
    const base = `${String(n).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}`;
    const page = this.page;
    const shot = await page.screenshot(join(this.dir, `${base}.png`));
    const url = await page.url();
    const onOrigin = url.startsWith(ORIGIN);
    const live = onOrigin ? (await page.eval(SW_STATE)).value ?? null : null;
    let cacheState = onOrigin ? (await page.eval(CACHE_STATE)).value ?? null : null;
    let cacheSource = 'page';
    if (!cacheState) {
      const viaWorker = await this.browser.workerEval(CACHE_STATE);
      if (viaWorker) {
        cacheState = viaWorker.value;
        cacheSource = 'service worker target';
      }
    }
    if (!cacheState && this.cachesBeforeOffline) {
      cacheState = this.cachesBeforeOffline;
      cacheSource = 'snapshot taken just before going offline';
    }
    const report = {
      label,
      url,
      readyState: onOrigin ? (await page.eval('document.readyState')).value : '(not on the app origin)',
      bodyText: await page.bodyText(500),
      screenshot: shot,
      serviceWorker: live,
      cacheSource,
      cacheState,
      pageConsole: page.console,
      workerConsole: this.browser.workerConsole(),
      failedRequests: page.failed,
      badResponses: page.badResponses,
      topLevelNavigations: page.frameNavigations,
      proxyBlockedRequests: this.proxy.blocked(this.proxyMark ?? 0).map((r) => `${r.mode} ${r.method} ${r.url}`),
      ...extra,
    };
    writeFileSync(join(this.dir, `${base}.json`), JSON.stringify(report, null, 2));
    return report;
  }

  markProxy() {
    this.proxyMark = this.proxy.logLength;
  }
}

// ---------------------------------------------------------------------------
// Steps shared by the scenarios
// ---------------------------------------------------------------------------

/**
 * Opens a URL and waits until `isDone` (an expression) is true, polling while
 * the navigation is still in flight. Returns early on Chrome's own error page.
 */
async function openAndWait(ctx, url, isDone, { timeoutMs = 12000 } = {}) {
  const page = ctx.page;
  page.resetEvidence();
  ctx.markProxy();
  const started = Date.now();
  const navigation = page.send('Page.navigate', { url }, timeoutMs + 2000).catch((e) => ({ errorText: e.message }));
  let navResult;
  navigation.then((r) => {
    navResult = r;
  });
  for (;;) {
    const elapsed = Date.now() - started;
    const href = await page.url();
    if (href.startsWith('chrome-error:')) {
      return { ok: false, ms: elapsed, why: `Chrome error page (${navResult?.errorText ?? 'navigation failed'})` };
    }
    if (href.startsWith(ORIGIN)) {
      const done = await page.eval(isDone, 3000);
      if (done.value) {
        ctx.refusedSample = ctx.proxy.blocked(ctx.proxyMark ?? 0).length;
        return { ok: true, ms: Date.now() - started };
      }
    }
    if (elapsed > timeoutMs) {
      ctx.refusedSample = ctx.proxy.blocked(ctx.proxyMark ?? 0).length;
      let state;
      if (href.startsWith(ORIGIN)) {
        const body = (await page.bodyText(90)).trim();
        const dead = /No internet connection/.test(await page.bodyText(600)) ? ' (the /offline fallback, painted but never hydrated)' : '';
        state = `a page is painted but not interactive${dead}: "${body}"`;
      } else {
        const held = ctx.proxy.blocked(ctx.proxyMark ?? 0).filter((r) => r.mode === 'hang');
        state = `the navigation never committed, still at ${href || 'about:blank'}${held.length ? `; the proxy is holding ${held.length} request(s), first ${held[0].method} ${held[0].url}` : ''}`;
      }
      return { ok: false, ms: elapsed, why: `no interactive page after ${timeoutMs} ms, ${state}` };
    }
    await sleep(150);
  }
}

/** Real typing and a real click: proves the page is hydrated, not just painted. */
async function proveInteractive(ctx) {
  const page = ctx.page;
  const ready = await page.waitFor(HYDRATED_SEARCH_BOX, { timeoutMs: 4000 });
  if (!ready.ok) return { ok: false, why: 'search box missing or not hydrated' };
  const typed = await page.type('textarea', 'Haus');
  const value = (await page.eval(`document.querySelector('textarea').value`)).value;
  if (!typed || value !== 'Haus') return { ok: false, why: `typing did not land (value "${value}")` };
  const clicked = await page.click('button[aria-label="Account menu"]');
  const opened = clicked && (await page.waitFor(`document.querySelector('button[aria-label="Account menu"]')?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 2000 })).ok;
  if (!opened) return { ok: false, why: 'the account menu did not open on click' };
  await page.press('Escape', 'Escape', 27);
  return { ok: true };
}

/** Sign in through the real screens, as a new reader would, from /welcome. */
async function signInThroughUi(ctx) {
  const page = ctx.page;
  const welcome = await page.goto(`${ORIGIN}/welcome`);
  if (!welcome.ok) throw new Error(`/welcome did not load online: ${JSON.stringify(welcome)}`);
  if (!(await page.waitFor(hydrated('a[href="/sign-in"]'), { timeoutMs: 8000 })).ok) {
    throw new Error('/welcome has no sign-in link');
  }
  await page.click('a[href="/sign-in"]');
  if (!(await page.waitFor(hydrated('input[name=email]'), { timeoutMs: 8000 })).ok) {
    throw new Error('the sign-in form did not appear');
  }
  await page.type('input[name=email]', EMAIL);
  await page.type('input[name=password]', PASSWORD);
  // A click that arrives before the form's own handlers are attached is lost
  // without a trace, so click again until the app leaves /sign-in.
  let landed = { ok: false };
  for (let attempt = 0; attempt < 5 && !landed.ok; attempt++) {
    await page.click('form button[type=submit]');
    landed = await page.waitFor(`location.pathname === '/' && ${HYDRATED_SEARCH_BOX}`, { timeoutMs: 4000 });
  }
  if (!landed.ok) throw new Error(`sign-in did not land on a working /: at ${await page.url()}`);
}

async function waitForActiveWorker(ctx) {
  const ready = await ctx.page.waitFor(
    `navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active && r.active.state === 'activated' && !!navigator.serviceWorker.controller)`,
    { timeoutMs: 20000 },
  );
  if (!ready.ok) {
    const state = (await ctx.page.eval(SW_STATE)).value;
    ctx.note(`service worker not active and controlling after 20 s: ${JSON.stringify(state)}`);
  }
  await sleep(1500); // let the install precache and the first runtime cache writes settle
  return ready.ok;
}

/** Online visits that a returning reader has behind them. */
async function visitOnline(ctx, paths) {
  for (const path of paths) {
    const result = await ctx.page.goto(`${ORIGIN}${path}`);
    if (!result.ok) throw new Error(`${path} did not load online: ${JSON.stringify(result)}`);
    await ctx.page.waitFor(HYDRATED_SEARCH_BOX, { timeoutMs: 8000 });
    await sleep(1000);
  }
}

/** A returning reader: signed in, worker active, / and /lists opened online. */
async function returningReader(ctx) {
  await signInThroughUi(ctx);
  await waitForActiveWorker(ctx);
  await visitOnline(ctx, ['/', '/lists', '/']);
}

/** The text a client-side navigation leaves behind, and whether it is a crash. */
async function describeScreen(page) {
  const text = await page.bodyText(300);
  const heading = (await page.eval(`document.querySelector('h1')?.textContent ?? ''`)).value;
  return { text, heading, crashed: ERROR_TEXT.test(text) };
}

/** One line saying what a client-side navigation did. */
function describeNav(href, result) {
  if (result.ok === false) return result.why;
  if (result.crashed) return 'ERROR BOUNDARY (Oops!)';
  if (result.path !== href) {
    const reloaded = result.routeModuleFailed ? ', route chunk missing so the router reloaded the page' : '';
    return `NOTHING HAPPENED, still on ${result.path} with no message${reloaded}`;
  }
  return `ok, opened "${result.heading}"`;
}

/** Boot online, go offline, click a nav link, report what the screen shows. */
async function offlineClientNav(ctx, href) {
  await ctx.page.goto(`${ORIGIN}/`);
  await ctx.page.waitFor(HYDRATED_SEARCH_BOX, { timeoutMs: 8000 });
  await sleep(800);
  await ctx.goOffline();
  ctx.page.resetEvidence();
  ctx.markProxy();
  const clicked = await ctx.page.click(`a[href="${href}"]`);
  if (!clicked) return { ok: false, why: `no visible link to ${href}` };
  await ctx.page.waitFor(`location.pathname === ${JSON.stringify(href)}`, { timeoutMs: 6000 });
  await sleep(2000);
  const screen = await describeScreen(ctx.page);
  const path = new URL(await ctx.page.url()).pathname;
  const routeModuleFailed = ctx.page.console.some((c) => /Error loading route module/.test(c.text));
  return { ...screen, path, routeModuleFailed };
}


const HINT_KEY = 'kenning-signed-in-hint';
const SESSION_COOKIE = '_session';

/** The stored signed-in hint, parsed. `null` when none, the string 'unparseable' when it is not JSON. */
const READ_HINT = `(() => {
  const raw = localStorage.getItem(${JSON.stringify(HINT_KEY)});
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return 'unparseable'; }
})()`;

/** True when every one of these links is drawn with a real box (sidebar at this width, or the tabs). */
const navLinksDrawn = (hrefs) => `(() => ${JSON.stringify(hrefs)}.every((h) =>
  [...document.querySelectorAll('a[href="' + h + '"]')].some((a) => {
    const r = a.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })))()`;

/** The "sync is paused" ribbon, or null. It is an <output> element (sync-paused-ribbon.tsx). */
const PAUSED_RIBBON = `(() => {
  const o = [...document.querySelectorAll('output')].find((e) => /Sync is paused/.test(e.innerText));
  if (!o) return null;
  const a = o.querySelector('a');
  return { text: o.innerText.replace(/\\s+/g, ' ').trim(), href: a ? a.getAttribute('href') : null };
})()`;

/** The sentence the account doors show a device that still holds data (device-data-kept-notice.tsx). */
const DEVICE_DATA_KEPT = `/Your lists and favourites stay on this device/.test(document.body.innerText)`;

/** One line for a hint, for the report. */
const showHint = (hint) => (hint === null ? 'none' : JSON.stringify(hint));

/**
 * Online: opens /lists, creates a list through the form, and waits until the
 * device store has had time to persist it (its persister polls every second)
 * and the debounced push has gone out.
 */
async function createListThroughUi(ctx, name) {
  const page = ctx.page;
  if ((await page.url()) !== `${ORIGIN}/lists`) {
    const opened = await page.goto(`${ORIGIN}/lists`);
    if (!opened.ok) throw new Error(`/lists did not load online: ${JSON.stringify(opened)}`);
  }
  if (!(await page.waitFor(hydrated('#new-list-name'), { timeoutMs: 8000 })).ok) throw new Error('the new-list field is missing or not hydrated');
  const typed = await page.type('#new-list-name', name);
  await page.click('#new-list-name ~ button, form button[type=submit]');
  const made = typed && (await page.waitFor(`document.body.innerText.includes(${JSON.stringify(name)})`, { timeoutMs: 5000 })).ok;
  if (!made) throw new Error(`the list "${name}" did not appear after the form was submitted`);
  await sleep(3000);
}

/** Clicks a nav link on a booted app and describes where it landed. Works online and offline. */
async function clientNavTo(ctx, href) {
  ctx.page.resetEvidence();
  const clicked = await ctx.page.click(`a[href="${href}"]`);
  if (!clicked) return { ok: false, why: `no visible link to ${href}` };
  await ctx.page.waitFor(`location.pathname === ${JSON.stringify(href)}`, { timeoutMs: 6000 });
  await sleep(1500);
  const screen = await describeScreen(ctx.page);
  return { ...screen, path: new URL(await ctx.page.url()).pathname };
}

/** Collects named checks, so a scenario can report every failed one in a single line. */
function checks() {
  const passed = [];
  const failed = [];
  return {
    check(label, ok, info = '') {
      (ok ? passed : failed).push(info ? `${label} (${info})` : label);
      return ok;
    },
    passed,
    failed,
    verdict(summary) {
      return failed.length === 0
        ? { ok: true, detail: summary }
        : { ok: false, detail: `FAILED: ${failed.join('; ')}${summary ? ` | passed: ${passed.length}, ${summary}` : ''}` };
    },
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios = [
  {
    id: 'S1',
    name: 'fresh install, nothing else visited, offline cold open of /',
    async run(ctx) {
      await signInThroughUi(ctx);
      await waitForActiveWorker(ctx);
      await ctx.goOffline();
      await ctx.coldStart();
      const opened = await openAndWait(ctx, `${ORIGIN}/`, HYDRATED_SEARCH_BOX);
      if (!opened.ok) return { ok: false, detail: opened.why };
      const live = await proveInteractive(ctx);
      return live.ok ? { ok: true, detail: `interactive after ${opened.ms} ms` } : { ok: false, detail: live.why };
    },
  },
  {
    id: 'S2',
    name: 'returning reader (opened / and /lists online), offline cold open of /',
    async run(ctx) {
      await returningReader(ctx);
      await ctx.goOffline();
      await ctx.coldStart();
      const opened = await openAndWait(ctx, `${ORIGIN}/`, HYDRATED_SEARCH_BOX);
      if (!opened.ok) return { ok: false, detail: opened.why };
      const live = await proveInteractive(ctx);
      return live.ok ? { ok: true, detail: `interactive after ${opened.ms} ms` } : { ok: false, detail: live.why };
    },
  },
  {
    id: 'S3',
    name: 'offline cold open of /?q=Haus with a device dictionary',
    async run(ctx) {
      await returningReader(ctx);
      await ctx.page.eval(FAKE_DICTIONARY);
      const query = `${ORIGIN}/?from=de&to=en&q=Haus`;
      const hit = `/Device dictionary/.test(document.body.innerText) && /house/.test(document.body.innerText)`;
      const online = await openAndWait(ctx, query, hit, { timeoutMs: 10000 });
      if (!online.ok) return { ok: false, detail: `SETUP: the device hit did not show even online (${online.why})` };
      await ctx.goOffline();
      await ctx.coldStart();
      const opened = await openAndWait(ctx, query, hit);
      if (!opened.ok) return { ok: false, detail: opened.why };
      return { ok: true, detail: `device hit "house" rendered after ${opened.ms} ms` };
    },
  },
  {
    id: 'S4',
    name: 'offline, booted app: client navigation to lists, favourites, quiz, create a list',
    async run(ctx) {
      await returningReader(ctx);
      const failures = [];
      const seen = [];
      for (const href of ['/lists', '/favourites', '/quiz']) {
        await ctx.goOnline();
        const result = await offlineClientNav(ctx, href);
        seen.push(`${href}: ${describeNav(href, result)}`);
        if (result.ok === false || result.crashed || result.path !== href) {
          failures.push(href);
          await ctx.evidence(`client-nav-${href.slice(1)}`, { result });
        }
      }
      // A write, offline: the list lives in this device's own store.
      await ctx.goOnline();
      const nav = await offlineClientNav(ctx, '/lists');
      if (nav.ok !== false && !nav.crashed) {
        const typed = await ctx.page.type('#new-list-name', 'Offline travel');
        await ctx.page.click('#new-list-name ~ button, form button[type=submit]');
        const made = typed && (await ctx.page.waitFor(`/Offline travel/.test(document.body.innerText)`, { timeoutMs: 5000 })).ok;
        seen.push(`create list: ${made ? 'ok' : 'NOT SHOWN'}`);
        if (!made) {
          failures.push('create-list');
          await ctx.evidence('create-list');
        }
      } else {
        failures.push('create-list (lists did not open)');
      }
      return { ok: failures.length === 0, detail: seen.join(' | '), skipEvidence: true };
    },
  },
  {
    id: 'S5',
    name: 'offline client navigation to /history and /settings: calm message, no crash',
    async run(ctx) {
      await returningReader(ctx);
      const failures = [];
      const seen = [];
      // Each screen twice. "cold": never opened on this device, so its route
      // chunk may be missing. "visited": opened online before, so the chunk is
      // cached and only the missing server data is left to handle.
      for (const visited of [false, true]) {
        for (const href of ['/history', '/settings']) {
          await ctx.goOnline();
          if (visited) {
            await ctx.page.goto(`${ORIGIN}${href}`);
            await ctx.page.waitFor(`document.body.innerText.length > 50`, { timeoutMs: 6000 });
            await sleep(1000);
          }
          const result = await offlineClientNav(ctx, href);
          const calm = result.ok !== false && !result.crashed && result.path === href && OFFLINE_NOTICE.test(result.text);
          const label = `${href} ${visited ? 'visited' : 'cold'}`;
          seen.push(`${label}: ${calm ? 'calm notice' : describeNav(href, result)}${result.crashed ? ` "${result.text.slice(0, 60)}"` : ''}`);
          if (!calm) {
            failures.push(label);
            await ctx.evidence(`client-nav-${href.slice(1)}-${visited ? 'visited' : 'cold'}`, { result });
          }
        }
      }
      return { ok: failures.length === 0, detail: seen.join(' | '), skipEvidence: true };
    },
  },
  {
    id: 'S6',
    name: 'HANG: network requests never settle, cold open of / paints within 6 s and becomes usable',
    async run(ctx) {
      await returningReader(ctx);
      ctx.cachesBeforeOffline = (await ctx.page.eval(CACHE_STATE)).value ?? null;
      await ctx.coldStart();
      ctx.proxy.setMode('hang'); // the browser is "online" but nothing answers
      // 1. Past the splash screen: SOMETHING must paint quickly. This is the bug.
      const painted = await openAndWait(ctx, `${ORIGIN}/`, 'document.body.innerText.trim().length > 50', { timeoutMs: 8000 });
      if (!painted.ok) return { ok: false, detail: `${painted.why}` };
      if (painted.ms > 6000) return { ok: false, detail: `first paint only after ${painted.ms} ms (budget 6000 ms)` };
      // 2. Then the app must become usable. Budget: 4 s navigation timeout + 2.5 s reachability
      // probe + 3 s data wait + hydration, with headroom.
      const usable = await ctx.page.waitFor(HYDRATED_SEARCH_BOX, { timeoutMs: 12000 });
      if (!usable.ok) return { ok: false, detail: `painted after ${painted.ms} ms but never became interactive within 15 s` };
      const live = await proveInteractive(ctx);
      return live.ok ? { ok: true, detail: `painted after ${painted.ms} ms, interactive` } : { ok: false, detail: live.why };
    },
  },
  {
    id: 'S7',
    name: 'back online without reload: a search gives a normal server result',
    async run(ctx) {
      await returningReader(ctx);
      const steps = [];
      for (const withFailedNav of [false, true]) {
        const label = withFailedNav ? 'after a failed offline navigation' : 'after a plain offline blip';
        await ctx.goOnline();
        await ctx.page.goto(`${ORIGIN}/`);
        await ctx.page.waitFor(HYDRATED_SEARCH_BOX, { timeoutMs: 8000 });
        await sleep(800);
        await ctx.goOffline();
        if (withFailedNav) {
          await ctx.page.click('a[href="/history"]');
          await sleep(2500);
        } else {
          await sleep(1500);
        }
        await ctx.goOnline();
        await sleep(1500);
        if (withFailedNav) {
          // The failed screen shows its calm notice, as it should. The reader taps Translate to search again.
          await ctx.page.click('a[href="/"]');
          await ctx.page.waitFor(HYDRATED_SEARCH_BOX, { timeoutMs: 8000 });
        }
        ctx.page.resetEvidence();
        const word = withFailedNav ? 'Wort' : 'Haus';
        const typed = await ctx.page.type('textarea', word);
        const submitted =
          typed &&
          (await ctx.page.eval(`(() => { const b = document.querySelector('textarea').form?.querySelector('button[type=submit]'); if (!b) return false; b.setAttribute('data-oc', '1'); return true; })()`)).value &&
          (await ctx.page.click('[data-oc="1"]'));
        const shown = submitted
          ? await ctx.page.waitFor(`location.search.includes('q=${word}') && /Nothing matched ${word}|No entry for this word/.test(document.body.innerText)`, { timeoutMs: 10000 })
          : { ok: false };
        const stuck = await ctx.page.eval(`/No internet connection|Offline\\. Changes/.test(document.body.innerText)`);
        const good = shown.ok && !stuck.value;
        steps.push(`${label}: ${good ? 'server result shown' : submitted ? (stuck.value ? 'offline notice still shown' : 'no result') : 'could not search (' + (typed ? 'no submit button' : 'no search box') + ')'}`);
        if (!good) await ctx.evidence(withFailedNav ? 'after-failed-nav' : 'after-blip');
      }
      return { ok: steps.every((s) => s.includes('server result shown')), detail: steps.join(' | '), skipEvidence: true };
    },
  },
  {
    id: 'S8',
    name: 'returning reader, offline cold open with NO session cookie: shell, nav, lists and hint intact',
    async run(ctx) {
      await returningReader(ctx);
      await createListThroughUi(ctx, 'Plane list');
      const before = (await ctx.page.eval(READ_HINT)).value;
      if (before === null || typeof before !== 'object') return { ok: false, detail: `SETUP: no signed-in hint after signing in (${showHint(before)})` };
      await ctx.goOffline();
      const done = await ctx.coldStart({ dropCookies: [SESSION_COOKIE] });
      const c = checks();
      const cookieGone = !(await ctx.browser.allCookies()).some((k) => k.name === SESSION_COOKIE);
      if (!cookieGone) throw new Error(`HARNESS: ${SESSION_COOKIE} is still in the profile after a drop (${JSON.stringify(done)})`);

      const opened = await openAndWait(ctx, `${ORIGIN}/`, HYDRATED_SEARCH_BOX);
      if (!c.check('/ is hydrated', opened.ok, opened.ok ? `${opened.ms} ms` : opened.why)) return c.verdict('');
      const live = await proveInteractive(ctx);
      c.check('/ is interactive (typing and a click land)', live.ok, live.why);
      c.check('the page reports offline (navigator.onLine)', (await ctx.page.eval('navigator.onLine')).value === false);
      c.check('nav links drawn (/lists /favourites /quiz)', (await ctx.page.eval(navLinksDrawn(['/lists', '/favourites', '/quiz']))).value === true);

      const lists = await clientNavTo(ctx, '/lists');
      c.check('/lists opens', lists.ok !== false && !lists.crashed && lists.path === '/lists', describeNav('/lists', lists));
      const hasList = (await ctx.page.waitFor(`document.body.innerText.includes('Plane list')`, { timeoutMs: 4000 })).ok;
      c.check('/lists shows "Plane list"', hasList, hasList ? '' : (await ctx.page.bodyText(120)));
      for (const href of ['/favourites', '/quiz']) {
        const result = await clientNavTo(ctx, href);
        c.check(`${href} opens with no error boundary`, result.ok !== false && !result.crashed && result.path === href, describeNav(href, result));
      }
      const after = (await ctx.page.eval(READ_HINT)).value;
      c.check('hint still present and not paused', after !== null && typeof after === 'object' && after.pause === undefined && after.userId === before.userId, showHint(after));
      return c.verdict(`/ ${opened.ms} ms, no ${SESSION_COOKIE} (${JSON.stringify(done.dropped)}), hint ${showHint(after)}`);
    },
  },
  {
    id: 'S9',
    name: 'session dies while online: one 401, sync pauses, nothing is lost, signing in again resumes',
    async run(ctx) {
      const setupMark = ctx.proxy.logLength;
      const setupT0 = Date.now();
      await returningReader(ctx);
      await createListThroughUi(ctx, 'Plane list');
      ctx.note(`sync calls while signing in and making the first list (control): ${ctx.proxy.requests(setupMark, '/api/v1/sync').map((r) => `${r.method} ${r.status}@${((r.at - setupT0) / 1000).toFixed(1)}s`).join(',')}`);
      const c = checks();
      const hintBefore = (await ctx.page.eval(READ_HINT)).value;
      if (hintBefore === null || typeof hintBefore !== 'object' || hintBefore.pause) return { ok: false, detail: `SETUP: hint before the expiry is ${showHint(hintBefore)}` };
      const syncCalls = (since) => ctx.proxy.requests(since, '/api/v1/sync');
      const t0 = Date.now();
      const statuses = (calls) => calls.map((r) => `${r.method} ${r.status}@${((r.at - t0) / 1000).toFixed(1)}s`).join(',') || 'none';

      // 1. The cookie dies in the live browser, then the tab regains focus.
      const mark1 = ctx.proxy.logLength;
      const deleted = await ctx.browser.deleteCookie(SESSION_COOKIE);
      if (deleted === 0) throw new Error(`HARNESS: there was no ${SESSION_COOKIE} to delete`);
      await ctx.page.eval(`window.dispatchEvent(new Event('focus'))`);
      await sleep(2500);
      const first = syncCalls(mark1);
      const refused = first.filter((r) => r.path === '/api/v1/sync/blob' && r.status === 401);
      c.check('exactly ONE 401 on /api/v1/sync/blob', refused.length === 1 && first.length === 1, `sync calls: ${statuses(first)}`);
      const ribbon = (await ctx.page.waitFor(PAUSED_RIBBON, { timeoutMs: 4000 })).value ?? null;
      c.check('ribbon visible with a sign-in link carrying next', ribbon !== null && /^\/sign-in\?next=/.test(ribbon.href ?? ''), ribbon ? `${ribbon.text} -> ${ribbon.href}` : 'no ribbon');
      const paused = (await ctx.page.eval(READ_HINT)).value;
      c.check("hint pause.reason is 'expired'", paused?.pause?.reason === 'expired' && paused.userId === hintBefore.userId, showHint(paused));

      // 2. Three more focus events and a local edit send nothing.
      const mark2 = ctx.proxy.logLength;
      for (let i = 0; i < 3; i++) {
        await ctx.page.eval(`window.dispatchEvent(new Event('focus'))`);
        await sleep(500);
      }
      await createListThroughUi(ctx, 'Paused edit'); // waits 3 s, past the 1.5 s push debounce
      const extra = syncCalls(mark2);
      c.check('3 focus events and a local edit send NO sync request', extra.length === 0, `sync calls: ${statuses(extra)}`);

      // 3. Offline cold open, cookie still gone: the shell and the list are there, and no ribbon.
      await ctx.goOffline();
      const done = await ctx.coldStart();
      c.check(`no ${SESSION_COOKIE} after the cold start`, !(await ctx.browser.allCookies()).some((k) => k.name === SESSION_COOKIE));
      const opened = await openAndWait(ctx, `${ORIGIN}/`, HYDRATED_SEARCH_BOX);
      c.check('offline / is hydrated', opened.ok, opened.ok ? `${opened.ms} ms` : opened.why);
      if (opened.ok) {
        c.check('offline nav links drawn', (await ctx.page.eval(navLinksDrawn(['/lists', '/favourites', '/quiz']))).value === true);
        const lists = await clientNavTo(ctx, '/lists');
        const seen = (await ctx.page.waitFor(`document.body.innerText.includes('Plane list') && document.body.innerText.includes('Paused edit')`, { timeoutMs: 4000 })).ok;
        c.check('offline /lists shows both lists', lists.path === '/lists' && seen, describeNav('/lists', lists));
        await sleep(1500);
        const offlineRibbon = (await ctx.page.eval(PAUSED_RIBBON)).value;
        c.check('NO ribbon while offline', offlineRibbon === null, `${offlineRibbon?.text ?? ''} navigator.onLine=${(await ctx.page.eval('navigator.onLine')).value}`);
        const offlineHint = (await ctx.page.eval(READ_HINT)).value;
        c.check('hint still paused (expired) offline', offlineHint?.pause?.reason === 'expired', showHint(offlineHint));
      }

      // 4. Back online with no cookie: / hops to /welcome, which says the data is kept.
      await ctx.goOnline();
      const welcome = await openAndWait(ctx, `${ORIGIN}/`, `location.pathname === '/welcome' && ${DEVICE_DATA_KEPT}`, { timeoutMs: 10000 });
      c.check('online / lands on /welcome with the device-data-kept notice', welcome.ok, welcome.ok ? '' : welcome.why);

      // 5. Sign in again as the same seeded account.
      const mark3 = ctx.proxy.logLength;
      await signInThroughUi(ctx);
      await sleep(9000);
      const resumed = syncCalls(mark3);
      // The FIRST request after the sign-in is the pull that resumes sync. The
      // calls after it are the app's own follow-ups: applying the pull and
      // pushing the edit made during the pause write to the store, and each
      // write arms the 1.5 s push debounce, which runs one more cycle. They are
      // bounded (the chain must end well inside the window), and none may fail.
      const refusedAfter = resumed.filter((r) => r.status !== 200);
      c.check('first request after sign-in is a pull that returns 200, none is refused', resumed[0]?.method === 'GET' && resumed[0].status === 200 && refusedAfter.length === 0, `sync calls: ${statuses(resumed)}`);
      c.check('at most one push (the edit made during the pause)', resumed.filter((r) => r.method === 'POST').length <= 1);
      c.check('sync settles (bounded follow-ups, quiet for the last 3 s)', resumed.length <= 5 && (resumed.length === 0 || Date.now() - resumed.at(-1).at > 3000), `${resumed.length} calls`);
      c.check('ribbon gone', (await ctx.page.eval(PAUSED_RIBBON)).value === null);
      const cleared = (await ctx.page.eval(READ_HINT)).value;
      c.check('hint pause cleared, same account', cleared !== null && typeof cleared === 'object' && cleared.pause === undefined && cleared.userId === hintBefore.userId, showHint(cleared));
      const lists = await clientNavTo(ctx, '/lists');
      const survives = (await ctx.page.waitFor(`document.body.innerText.includes('Plane list') && document.body.innerText.includes('Paused edit')`, { timeoutMs: 4000 })).ok;
      c.check('"Plane list" and "Paused edit" survive', lists.path === '/lists' && survives);
      return c.verdict(`401 once, ${done.restored.length} cookies restored in the cold start, resume ${statuses(resumed)}`);
    },
  },
  {
    id: 'S10',
    name: 'cookie fix: a cold start that restores NO cookies still has the session (Max-Age is persisted)',
    async run(ctx) {
      await signInThroughUi(ctx);
      await sleep(1000);
      const c = checks();
      const before = (await ctx.browser.allCookies()).find((k) => k.name === SESSION_COOKIE);
      if (!before) throw new Error(`HARNESS: signed in but there is no ${SESSION_COOKIE} cookie`);
      const days = typeof before.expires === 'number' ? (before.expires - Date.now() / 1000) / 86400 : null;
      c.check('Set-Cookie carries an expiry, not a session cookie', before.session === false && days !== null && days > 0, `session=${before.session} expires=${before.expires}`);
      c.check('expiry is about 400 days out', days !== null && days > 399 && days < 401, days === null ? 'n/a' : `${days.toFixed(1)} days`);
      if (c.failed.length > 0) return c.verdict('');

      // Nothing is put back: only what Chromium wrote to its own profile can survive.
      const done = await ctx.coldStart({ restoreCookies: false });
      const after = (await ctx.browser.allCookies()).find((k) => k.name === SESSION_COOKIE);
      if (!after) {
        // The app did its part (an expiry 400 days out). If Chromium still lost
        // it, the cause is the profile or the launch flags, not the cookie.
        return { ok: false, detail: `HARNESS/PROFILE: ${SESSION_COOKIE} had expires=${before.expires} (${days.toFixed(1)} days) but the browser did not keep it across a restart with restoreCookies=false (${JSON.stringify(done)}). Not forced to pass.` };
      }
      c.check(`${SESSION_COOKIE} survived the restart in the profile`, true, `expires ${after.expires}`);
      const opened = await openAndWait(ctx, `${ORIGIN}/lists`, hydrated('#new-list-name'), { timeoutMs: 12000 });
      const path = new URL(await ctx.page.url()).pathname;
      const bounced = ctx.page.frameNavigations.some((u) => u.includes('/sign-in'));
      c.check('/lists loads online without a redirect to /sign-in', opened.ok && path === '/lists' && !bounced, opened.ok ? `at ${path}${bounced ? ', passed through /sign-in' : ''}` : opened.why);
      return c.verdict(`cookie expires in ${days.toFixed(1)} days, survived a restart with nothing restored, /lists opened signed in`);
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let activeCtx = null;

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chromium not found at ${CHROME}. Set CHROME_PATH.`);
  if (!existsSync(join(here, '../../build/server/index.js'))) {
    throw new Error('No production build. Run `pnpm build` first (run.sh does it for you).');
  }

  let app = null;
  if (!useExistingApp) {
    console.log(`[setup] starting the production build on 127.0.0.1:${APP_PORT} (db ${DB_NAME})`);
    app = await startApp({ port: APP_PORT, publicOrigin: ORIGIN, dbName: DB_NAME, logFile: join(outDir, 'app.log') });
  }
  const proxy = createProxy({ listenPort: PROXY_PORT, targetPort: APP_PORT });
  await proxy.listen();
  console.log(`[setup] fault proxy on 127.0.0.1:${PROXY_PORT}, origin ${ORIGIN}, artifacts in ${outDir}`);

  const results = [];
  const bail = async () => {
    await activeCtx?.stop().catch(() => {});
    await proxy.close().catch(() => {});
    if (app) await app.stop().catch(() => {});
    process.exit(130);
  };
  process.once('SIGINT', bail);
  process.once('SIGTERM', bail);
  try {
    for (const scenario of scenarios) {
      if (only && !only.includes(scenario.id)) continue;
      const ctx = new Ctx(scenario.id, proxy);
      activeCtx = ctx;
      let outcome;
      const started = Date.now();
      try {
        await ctx.start();
        outcome = await scenario.run(ctx);
        if (!outcome.ok && !outcome.skipEvidence) {
          outcome.evidence = await ctx.evidence('failure');
        }
      } catch (error) {
        outcome = { ok: false, detail: `ERROR ${error.message}` };
        try {
          outcome.evidence = await ctx.evidence('error');
        } catch {
          // keep the original error
        }
      } finally {
        await ctx.stop().catch(() => {});
      }
      const status = outcome.ok ? 'PASS' : outcome.detail.startsWith('ERROR') ? 'ERROR' : 'FAIL';
      results.push({ id: scenario.id, status, name: scenario.name, detail: outcome.detail });
      console.log(`${status} ${scenario.id} ${scenario.name}`);
      console.log(`     ${outcome.detail} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
      if (ctx.notes.length) console.log(`     notes: ${ctx.notes.join('; ')}`);
      if (outcome.evidence) {
        const e = outcome.evidence;
        console.log(`     evidence: ${e.screenshot}`);
        console.log(`       url=${e.url} controller=${JSON.stringify(e.serviceWorker?.controller ?? null)} onLine=${e.serviceWorker?.onLine}`);
        const names = Object.entries(e.cacheState?.caches ?? {}).map(([n, urls]) => `${n}:${urls.length}`);
        console.log(`       caches (${e.cacheSource}): ${names.join(' ') || 'none'}`);
        if (e.cacheState?.shell) console.log(`       cached "/" references ${e.cacheState.shell.assetsReferenced} assets, missing from caches: ${e.cacheState.shell.assetsMissingFromCaches.length}`);
        if (e.failedRequests.length) console.log(`       failed requests: ${e.failedRequests.slice(0, 4).map((r) => `${r.url.replace(ORIGIN, '')} ${r.error}`).join(', ')}`);
        if (e.pageConsole.length) console.log(`       console: ${e.pageConsole.slice(0, 3).map((c) => c.text.slice(0, 120)).join(' || ')}`);
        console.log(`       body: ${e.bodyText.slice(0, 160)}`);
      }
    }
  } finally {
    await proxy.close();
    if (app && !args.includes('--keep-app')) {
      await app.stop();
      console.log('[teardown] app stopped, port freed');
    }
  }

  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log('\nSummary');
  for (const r of results) console.log(`  ${r.status.padEnd(5)} ${r.id}  ${r.name}`);
  process.exitCode = results.every((r) => r.status === 'PASS') ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
