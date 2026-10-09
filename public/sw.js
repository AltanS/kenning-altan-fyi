// kenning.altan.fyi service worker, hand-rolled. No Workbox. Modelled on
// openplate/public/sw.js.
//
// WHAT THIS WORKER IS FOR. The installed app has to open and run with no
// network, and it must never show a stale answer. This app tells you what a
// word means, and a cached answer is indistinguishable from a live one. So the
// rule below has not changed: no route data (`.data`), no loader or action
// response, no `/api/*` call and no page HTML is ever cached, with ONE
// exception, the signed-out `/offline` page, which holds no user state.
//
// WHAT CHANGED, AND WHY.
//
//   1. The worker used to precache whatever HTML it could fetch while signed
//      out. Gated pages redirect, were dropped, and only three screens
//      survived. Now it precaches the BUILD instead: every hashed file the
//      build wrote (listed in `precache.json`, written by
//      `scripts/build-precache.ts`) plus `/offline`. With every JS chunk on the
//      device, the app shell hydrates offline on any route.
//   2. The install is all or nothing. A missing file, a redirect or a network
//      error FAILS the install, and the previous worker keeps serving. A
//      half-deployed server therefore cannot leave a device with a shell that
//      paints and cannot run. `/offline` is also checked against the file list,
//      so a page built from a different build than the list is refused.
//   3. A navigation never hangs. The old network-first code awaited `fetch`
//      with no limit, so a stalled connection left the installed app on its
//      splash screen forever. A navigation now waits four seconds.
//   4. A navigation is answered BEFORE any query-string rule, so offline
//      `/?q=word` reaches the offline page instead of the browser's error page.
//   5. A hung network no longer costs every route data request fifteen seconds.
//      After a navigation or a data request times out or fails, the worker waits
//      only three seconds for data for the next minute, and any network answer
//      ends that short wait at once.
//
// The stamp below is replaced at build time by `scripts/build-precache.ts`. It
// names the shell cache and makes this file differ between builds, which is what
// makes the browser install the new worker.
const PRECACHE_STAMP = '__PRECACHE_STAMP__';

// Hashed build files. Cumulative across builds: a file name carries its content,
// so an entry can never be stale. Entries that no recent build lists are pruned
// on activate.
const STATIC_CACHE = 'static-v4';
// The `/offline` HTML and nothing else. One cache per build.
const SHELL_CACHE = `shell-${PRECACHE_STAMP}`;
// Bookkeeping only: what the last install recorded. Read by the app to show
// whether the device is ready for offline use.
const META_CACHE = 'sw-meta';

const OFFLINE_PATH = '/offline';
const MANIFEST_PATH = '/precache.json';
const META_KEY = '/__sw-meta';
const CURRENT_MANIFEST_KEY = '/__sw-manifest-current';
const PREVIOUS_MANIFEST_KEY = '/__sw-manifest-previous';

// A navigation that has not answered in this long goes to the offline page.
const NAVIGATION_TIMEOUT_MS = 4000;
// While the network is known to be down (see `networkLooksDown`) a navigation
// waits less, so a reader who retries does not sit through the full wait again.
const NAVIGATION_TIMEOUT_DOWN_MS = 1500;
// A route data request gets longer, because it is a loader and not a document.
// The client treats the TypeError this produces as "offline".
const DATA_TIMEOUT_MS = 15000;
// While the network looks down, a data request gives up sooner, so a screen full
// of loaders does not wait fifteen seconds each for an answer that is not coming.
const DATA_TIMEOUT_DOWN_MS = 3000;
// How long a failure keeps the short data timeout alive.
const NETWORK_DOWN_MEMORY_MS = 60000;
// How many files install downloads at once.
const PRECACHE_CONCURRENCY = 6;

// Every fetch made by install skips the HTTP cache and sends no cookies. A
// cached copy could belong to the previous build, and the shell must never
// carry a signed-in reader's page.
const FRESH_FETCH = { cache: 'reload', credentials: 'omit' };

// Set when a navigation or a data request timed out or failed, cleared by any
// network answer. Lives in memory only: a restarted worker starts optimistic.
let networkLooksDown = false;
let networkLookedDownAt = 0;

// What `fetchWithin` loses to when the timer wins the race.
const TIMED_OUT = Symbol('timed-out');

// Same-origin /assets/ URLs inside HTML: script src, link href, modulepreload
// and inline import() strings all start with a quote or a bracket.
const ASSET_URL_PATTERN = /["'(](\/assets\/[^"'\s<>()\\?#]+)/g;

// The page shown when even the cached /offline page is gone. It needs nothing
// from the network or the cache, and its button only reloads, so it cannot loop.
const LAST_RESORT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #fff; color: #111; }
main { max-width: 28rem; padding: 1.5rem; }
h1 { font-size: 1.125rem; margin: 0 0 0.5rem; }
p { margin: 0 0 1rem; line-height: 1.5; }
button { font: inherit; padding: 0.5rem 1rem; }
</style>
</head>
<body>
<main>
<h1>No internet connection</h1>
<p>This page could not load. Check your connection, then try again.</p>
<button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Install, precache the build (all or nothing)
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(installThenActivate());
});

// `skipWaiting` comes last on purpose. Calling it before the precache finished
// would hand the page to a worker that cannot yet serve it offline.
async function installThenActivate() {
  await installPrecache();
  await self.skipWaiting();
}

async function installPrecache() {
  const manifest = await fetchManifest();
  const staticCache = await caches.open(STATIC_CACHE);
  await precacheMissingAssets(staticCache, manifest.assets);
  await precacheOfflinePage(new Set(manifest.assets));
  await recordInstall(manifest);
}

/** Downloads `precache.json` and refuses one that is not this worker's build. */
async function fetchManifest() {
  const response = await fetch(MANIFEST_PATH, FRESH_FETCH);
  assertPlainOk(response, MANIFEST_PATH);
  const manifest = await response.json();
  if (manifest.version !== 1) {
    throw new Error(`precache: unknown manifest version ${manifest.version}`);
  }
  if (manifest.stamp !== PRECACHE_STAMP) {
    // sw.js and precache.json come from one build. A mismatch means the server
    // is mid-deploy, or a cache served an old copy of one of the two.
    throw new Error(`precache: manifest stamp ${manifest.stamp} does not match worker stamp ${PRECACHE_STAMP}`);
  }
  const isValid = Array.isArray(manifest.assets) && manifest.assets.every((asset) => asset?.startsWith?.('/') === true);
  if (!isValid) throw new Error('precache: manifest assets are malformed');
  return manifest;
}

/** Throws unless the response is a 200 that did not pass through a redirect. */
function assertPlainOk(response, url) {
  if (!response.ok) throw new Error(`precache: ${url} answered ${response.status}`);
  if (response.redirected) throw new Error(`precache: ${url} redirected to ${response.url}`);
}

/** Fetches every listed file the cache does not already hold. Any failure rejects. */
async function precacheMissingAssets(cache, urls) {
  const held = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
  const queue = urls.filter((url) => !held.has(url));
  const workerCount = Math.min(PRECACHE_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workerCount }, () => drainQueue(queue, cache)));
}

async function drainQueue(queue, cache) {
  for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
    try {
      const response = await fetch(url, FRESH_FETCH);
      assertPlainOk(response, url);
      await cache.put(url, response);
    } catch (cause) {
      // Stop the other workers from starting new downloads for a doomed install.
      queue.length = 0;
      throw cause;
    }
  }
}

/** The /assets/ URLs a document names, de-duplicated. */
function findAssetUrls(html) {
  const urls = new Set();
  for (const match of html.matchAll(ASSET_URL_PATTERN)) urls.add(match[1]);
  return [...urls];
}

/**
 * Caches the `/offline` document, after proving every file it loads is on the
 * list. The page is fetched signed out (no cookies), so it holds no user state.
 */
async function precacheOfflinePage(listedAssets) {
  const response = await fetch(OFFLINE_PATH, FRESH_FETCH);
  assertPlainOk(response, OFFLINE_PATH);
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`precache: ${OFFLINE_PATH} is not an HTML document`);
  }

  const referenced = findAssetUrls(await response.clone().text());
  // A page that names no file at all is a parse failure, not a clean bill.
  if (referenced.length === 0) throw new Error(`precache: ${OFFLINE_PATH} names no /assets/ file`);
  const unlisted = referenced.filter((url) => !listedAssets.has(url));
  if (unlisted.length > 0) {
    throw new Error(`precache: ${OFFLINE_PATH} loads files that are not in the manifest: ${unlisted.join(', ')}`);
  }

  const shell = await caches.open(SHELL_CACHE);
  await shell.put(OFFLINE_PATH, response);
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

async function readJson(cache, key) {
  const response = await cache.match(key);
  if (response === undefined) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Writes the install record, last of all. The app reads `/__sw-meta` to decide
 * the device is ready, so it must not exist before everything above succeeded.
 * The previous build's file list is kept for one generation, so a tab that is
 * still open on the old build can lazy-load its chunks after this one activates.
 */
async function recordInstall(manifest) {
  const meta = await caches.open(META_CACHE);
  const previous = await readJson(meta, META_KEY);
  if (previous !== null && previous.stamp !== manifest.stamp) {
    const current = await meta.match(CURRENT_MANIFEST_KEY);
    if (current !== undefined) await meta.put(PREVIOUS_MANIFEST_KEY, current);
  }
  await meta.put(CURRENT_MANIFEST_KEY, jsonResponse(manifest.assets));
  await meta.put(
    META_KEY,
    jsonResponse({ stamp: manifest.stamp, installedAt: Date.now(), count: manifest.assets.length }),
  );
}

// ---------------------------------------------------------------------------
// Activate, drop old caches, prune old build files, then take over open pages
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(activateAndClaim());
});

async function activateAndClaim() {
  const names = await caches.keys();
  await Promise.all(names.filter(isObsoleteCache).map((name) => caches.delete(name)));
  await pruneStaticCache();
  await self.clients.claim();
}

function isObsoleteCache(name) {
  // `pages-*` held signed-in HTML in earlier versions. It is never read again.
  if (name.startsWith('pages-')) return true;
  if (name.startsWith('static-')) return name !== STATIC_CACHE;
  if (name.startsWith('shell-')) return name !== SHELL_CACHE;
  return false;
}

/** Drops hashed files that neither the current nor the previous build lists. */
async function pruneStaticCache() {
  const meta = await caches.open(META_CACHE);
  const current = await readJson(meta, CURRENT_MANIFEST_KEY);
  // No record means no basis for deleting anything.
  if (!Array.isArray(current)) return;
  const previous = await readJson(meta, PREVIOUS_MANIFEST_KEY);
  const keep = new Set([...current, ...(Array.isArray(previous) ? previous : [])]);

  const cache = await caches.open(STATIC_CACHE);
  const stale = (await cache.keys()).filter((request) => !keep.has(new URL(request.url).pathname));
  await Promise.all(stale.map((request) => cache.delete(request)));
}

// ---------------------------------------------------------------------------
// Fetch, per-request-type strategies, with route data never cached
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // A non-GET is a mutation. It always goes straight to the network.
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  const url = new URL(request.url);

  // Only same-origin GETs are handled. Anything external stays untouched.
  if (url.origin !== self.location.origin) return;

  // A navigation comes BEFORE the query-string rule below. A document request
  // for `/?q=word` carries a query string and still has to reach the offline
  // page when the network is gone.
  if (request.mode === 'navigate') {
    event.respondWith(answerNavigation(url, request));
    return;
  }

  if (isDataRequest(url)) {
    event.respondWith(answerData(request));
    return;
  }

  // The whole no-stale-answers rule, in one guard. API calls, the public
  // pages and any URL carrying a query string reach the network untouched, and
  // are never written to a cache.
  if (isUncacheable(url)) return;

  if (isStaticAsset(url, request)) {
    event.respondWith(cacheFirst(request));
  }
});

// ---------------------------------------------------------------------------
// Request classifiers
// ---------------------------------------------------------------------------

// The account screens. Every one of them renders differently depending on who
// is signed in, and two of them are reached from a mailed link. They are never
// served from cache.
const AUTH_PATHS = new Set([
  '/sign-in',
  '/sign-up',
  '/sign-out',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
]);

/** React Router's single-fetch route data, with or without a `_routes` search param. */
function isDataRequest(url) {
  return url.pathname.endsWith('.data');
}

/**
 * Never cache: route data, any `/api/` endpoint, any account screen, the public
 * browse pages, and any URL with a query string. A loader or action response is
 * live data by definition, and a query string means the URL names a specific
 * answer rather than a file.
 *
 * The browse rule is a take-down rule rather than a freshness one. An operator
 * can hide a public question at any moment, and a cached copy keeps it readable
 * on every device that opened the page before then.
 */
function isUncacheable(url) {
  if (isDataRequest(url)) return true;
  if (url.pathname.startsWith('/api/')) return true;
  if (url.pathname.startsWith('/browse/')) return true;
  if (AUTH_PATHS.has(url.pathname)) return true;
  if (url.search !== '') return true;
  return false;
}

function isStaticAsset(url, request) {
  return (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'font' ||
    request.destination === 'image' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/manifest.webmanifest'
  );
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Resolves with the response, or rejects when `ms` pass first. A stray late answer is dropped. */
async function fetchWithin(request, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, TIMED_OUT);
  });
  try {
    const result = await Promise.race([fetch(request), timeout]);
    if (result === TIMED_OUT) throw new Error(`no answer within ${ms} ms`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A timeout or a failed fetch means the network looks down. An abort does not:
 * the page cancelled its own request, which says nothing about the connection.
 */
function markNetworkDown(cause) {
  if (cause?.name === 'AbortError') return;
  networkLooksDown = true;
  networkLookedDownAt = Date.now();
}

function markNetworkUp() {
  networkLooksDown = false;
}

/** The short timeout applies only while the last failure is under a minute old. */
/** How long a document request waits, shorter while the network is known to be down. */
function navigationTimeoutMs() {
  const isRecent = Date.now() - networkLookedDownAt < NETWORK_DOWN_MEMORY_MS;
  return networkLooksDown && isRecent ? NAVIGATION_TIMEOUT_DOWN_MS : NAVIGATION_TIMEOUT_MS;
}

function dataTimeoutMs() {
  const isRecent = Date.now() - networkLookedDownAt < NETWORK_DOWN_MEMORY_MS;
  return networkLooksDown && isRecent ? DATA_TIMEOUT_DOWN_MS : DATA_TIMEOUT_MS;
}

/**
 * A document request. The network answer is returned whatever its status: a
 * server 500 is a real answer, and replacing it with a fallback would hide a
 * bug behind a page that blames the connection. Only a thrown fetch or a
 * timeout means "offline". No navigation response is ever cached.
 */
async function answerNavigation(url, request) {
  // THE OFFLINE PAGE COMES FROM THE CACHE FIRST. It is pinned to this build and
  // holds no user state, so there is nothing to gain from asking the network. On
  // a hung network that ask cost a second full timeout, right after the first one
  // had already sent the reader here. A missing copy (install not finished) falls
  // through to the network below.
  if (url.pathname === OFFLINE_PATH) {
    const cached = await readOfflinePage();
    if (cached !== undefined) return cached;
  }
  if (navigator.onLine !== false) {
    try {
      const response = await fetchWithin(request, navigationTimeoutMs());
      markNetworkUp();
      return response;
    } catch (cause) {
      // Falls through to the offline answer below.
      markNetworkDown(cause);
    }
  }
  return answerOffline(url);
}

async function answerOffline(url) {
  if (url.pathname === OFFLINE_PATH) {
    const cached = await readOfflinePage();
    if (cached !== undefined) return cached;
    return new Response(LAST_RESORT_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  // The offline page reads `next`, and brings the reader back here.
  const target = `${OFFLINE_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`;
  return Response.redirect(new URL(target, self.location.origin).href, 302);
}

async function readOfflinePage() {
  const shell = await caches.open(SHELL_CACHE);
  return shell.match(OFFLINE_PATH, { ignoreSearch: true });
}

/**
 * A route data request. Never cached. A TypeError from here is what the
 * client's loaders read as "offline", so both the no-network and the too-slow
 * case answer with a network error.
 */
async function answerData(request) {
  if (navigator.onLine === false) return Response.error();
  try {
    const response = await fetchWithin(request, dataTimeoutMs());
    markNetworkUp();
    return response;
  } catch (cause) {
    markNetworkDown(cause);
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(request);
    // Only a plain 200 is stored. A 404 or an error page cached under an asset
    // URL would outlive the fault that produced it.
    if (response.status === 200 && !response.redirected) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

// ---------------------------------------------------------------------------
// Messages, SKIP_WAITING (update flow) and CLEAR_CACHE
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  const { data } = event;
  if (!data || !data.type) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Kept so a page still running the old sign-out code does not break. No user
  // HTML is cached any more, so there is nothing to clear except the leftovers
  // of the older `pages-*` caches. The build files and the offline page are
  // not user data and stay.
  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(deleteLegacyPageCaches());
  }
});

async function deleteLegacyPageCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith('pages-')).map((name) => caches.delete(name)));
}
