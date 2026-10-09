import { z } from 'zod';

/**
 * The service worker, from the app's side: registering it, reporting whether
 * the device is ready for offline use, and adopting a newer one on demand.
 *
 * ── WHY THE REGISTRATION MOVED HERE ─────────────────────────────────────────
 *
 * It used to be four lines inside a `useEffect` in `root.tsx`. The behaviour is
 * unchanged, but `adoptNewestBundle` below needs the registration OBJECT, and
 * asking the browser for it a second time is both slower and one more thing
 * that can answer null. One module owns it now.
 *
 * ── PRODUCTION ONLY, AND THAT IS NOT AN OPTIMISATION ────────────────────────
 *
 * In dev the worker would sit between Vite and the browser and serve a stale
 * module graph, which reads as "my edit did nothing" rather than as a caching
 * bug. `import.meta.env.PROD` is a build-time constant, so the whole branch
 * leaves the dev bundle.
 *
 * Every failure is swallowed. An unsupported browser, a blocked origin or a
 * private window costs offline support, and it must never take the page down.
 */

/**
 * How long `adoptNewestBundle` waits for a fresh worker to reach `activated`
 * before it reloads anyway.
 *
 * Generous on purpose: the reload is what the reader just asked for, so the
 * failure to avoid is a button that appears to do nothing, not a slow one.
 */
const ACTIVATION_TIMEOUT_MS = 8_000;

/**
 * The live registration, kept so the manual reload path does not register a
 * second time. Null in dev, and until registration has resolved.
 */
let currentRegistration: ServiceWorkerRegistration | null = null;

/**
 * Reloads at most once per page life.
 *
 * `adoptNewestBundle` can reach the reload by two routes, a worker that
 * activated and a timeout that elapsed, and two reloads in a row is a visible
 * flash and, on a slow connection, a second one landing mid-load.
 */
let isRefreshing = false;

function reloadOnce(): void {
  if (isRefreshing) return;
  isRefreshing = true;
  window.location.reload();
}

/** Registers the worker and remembers the registration. Swallows every failure. */
async function registerAndRemember(): Promise<void> {
  try {
    currentRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    // The app works without a worker, it just loses offline support.
    return;
  }
  await askForPersistentStorage();
}

/** Set once the browser has been asked, so a refusal is not asked again on every launch. */
const PERSIST_ASKED_KEY = 'kenning.persist-storage-asked';

/**
 * Asks the browser not to evict this origin's storage, on the first launch that
 * is online. Precached files and the device store are only worth having if
 * they are still there next week. Best effort: a refusal, a missing API and a
 * blocked localStorage all cost nothing but the guarantee.
 */
async function askForPersistentStorage(): Promise<void> {
  try {
    if (navigator.onLine === false) return;
    if (window.localStorage.getItem(PERSIST_ASKED_KEY) !== null) return;
    window.localStorage.setItem(PERSIST_ASKED_KEY, '1');
    if (!navigator.storage?.persist) return;
    await navigator.storage.persist();
  } catch {
    // Not available here. Nothing depends on the answer.
  }
}

/** The cache and key `public/sw.js` writes its install record to. Keep in step with that file. */
const META_CACHE_NAME = 'sw-meta';
const META_KEY = '/__sw-meta';

/** What the worker's install records once every file is on the device. */
const installRecordSchema = z.object({
  stamp: z.string(),
  installedAt: z.number(),
  count: z.number(),
});

/**
 * Whether this device can open the app with no network.
 *
 * `controlled` is whether a worker controls THIS page, which a first visit
 * does not have until the next load. `precacheReady` is whether the worker's
 * install finished and recorded itself, and `stamp` names the build it
 * precached. Reads the Cache API directly, so it works offline.
 *
 * NEVER THROWS. In dev, in a browser with no worker and in a private window it
 * answers all false and null, which a caller can show as "not ready".
 */
export async function readOfflineReadiness(): Promise<{
  controlled: boolean;
  precacheReady: boolean;
  stamp: string | null;
}> {
  const notReady = { controlled: false, precacheReady: false, stamp: null };
  if (!import.meta.env.PROD) return notReady;
  try {
    if (!('serviceWorker' in navigator)) return notReady;
    const controlled = navigator.serviceWorker.controller !== null;
    const meta = await caches.open(META_CACHE_NAME);
    const response = await meta.match(META_KEY);
    if (response === undefined) return { controlled, precacheReady: false, stamp: null };
    const record = installRecordSchema.safeParse(await response.json());
    if (!record.success) return { controlled, precacheReady: false, stamp: null };
    return { controlled, precacheReady: true, stamp: record.data.stamp };
  } catch {
    return notReady;
  }
}

/** Registers the production service worker. Called once, from `root.tsx`. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  void registerAndRemember();
}

/** Resolves when the given worker reaches `activated`, or at once if it already has. */
function whenActivated(worker: ServiceWorker): Promise<void> {
  if (worker.state === 'activated') return Promise.resolve();
  return new Promise((resolve) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve();
    });
  });
}

/** A promise that resolves after `ms`, used as the losing half of a race. */
function afterDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Drops every registration for this origin. Best effort, like the rest of this module. */
async function unregisterAll(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    // Nothing actionable: the reload below still refetches the document.
  }
}

/**
 * Adopt the newest bundle this server is serving, then reload onto it.
 *
 * ── THE SEQUENCE ────────────────────────────────────────────────────────────
 *
 * `update()` refetches `sw.js`. `public/sw.js` calls `skipWaiting()` in its own
 * install handler, so a fresh worker usually goes straight from `installing` to
 * `activated` and never sits in `waiting`; the message below is for the case
 * where it sits there anyway, an install that raced the previous worker. Both
 * are watched, and the reload happens once either reaches `activated` or the
 * timeout elapses.
 *
 * Reloading on the timeout rather than giving up is deliberate. Nothing here
 * can tell "no new worker exists" from "the network is slow", and a plain
 * reload is correct for the first and harmless for the second.
 *
 * ── THE BRANCH THAT LOOKS WRONG AND IS NOT ──────────────────────────────────
 *
 * `update()` can succeed with nothing to install while the caller has just been
 * told this page is behind. That means the ACTIVE worker is serving stale
 * assets and will not replace itself, so it is dropped and the reload goes past
 * it. Without that branch the button would run, reload, and land on the same
 * old page, which is the one outcome worse than no button.
 */
export async function adoptNewestBundle(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    // Dev, or a browser with no worker: there is no cache layer to get past.
    reloadOnce();
    return;
  }

  const registration = currentRegistration ?? (await navigator.serviceWorker.getRegistration()) ?? null;
  if (registration === null) {
    reloadOnce();
    return;
  }

  try {
    await registration.update();
  } catch {
    // A thrown `update()` is a network failure, not a wedged worker. Keep the
    // precache, which is what an offline install has instead of a server.
    reloadOnce();
    return;
  }

  const waiting = registration.waiting;
  if (waiting !== null) {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- `ServiceWorker.postMessage` has no target-origin parameter; its second argument is a transfer list.
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  const fresh = registration.installing ?? registration.waiting;
  if (fresh === null) {
    await unregisterAll();
    reloadOnce();
    return;
  }

  await Promise.race([whenActivated(fresh), afterDelay(ACTIVATION_TIMEOUT_MS)]);
  reloadOnce();
}
