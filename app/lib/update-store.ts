/**
 * The browser's view of "is this page older than the server?", held outside
 * React.
 *
 * ── WHY A STORE AND NOT A HOOK'S OWN STATE ──────────────────────────────────
 *
 * The question is asked by the ribbon at the top of the app shell, and it will
 * be asked by anything else that wants to report the same thing. A hook holding
 * its own state would poll once per mounted component and, worse, could show
 * two different answers on one screen. One module-level store read through
 * `useSyncExternalStore` gives one poll and one answer.
 *
 * ── WHAT IT ASKS, AND WHAT IT DOES NOT ──────────────────────────────────────
 *
 * It asks `/api/build` what THIS server is serving, and folds the answer
 * through `observeServerBuild`. There is no second question about published
 * releases: kenning publishes none, and a ribbon reporting on a release feed
 * that does not exist would be checking nothing.
 *
 * ── NOTHING IS PERSISTED, AND THERE IS NO DISMISS ───────────────────────────
 *
 * The one thing this store can say is resolved by the button beside it: taking
 * the reload makes the sentence true no longer. A dismiss control would let a
 * reader silence a message about the page in front of them and then keep
 * reading a stale one, so there is nothing to remember between loads.
 */
import { BUILD, buildInfoSchema } from '#app/lib/build-info';
import { FRESH_BUNDLE, observeServerBuild, type BundleFreshness } from '#app/lib/bundle-freshness';

/** How often a visible tab asks the server again. */
export const POLL_INTERVAL_MS = 30 * 60 * 1000;

/** Where the server's own stamp is read from. */
export const BUILD_ENDPOINT = '/api/build';

/** Everything a component needs to render the update subject. */
export interface UpdateSnapshot {
  /** True once this page has seen two consecutive newer server commits. */
  bundleStale: boolean;
}

/** What server-rendered markup sees. Nothing has been fetched at that point. */
const SERVER_SNAPSHOT: UpdateSnapshot = { bundleStale: false };

let snapshot: UpdateSnapshot = SERVER_SNAPSHOT;
let freshness: BundleFreshness = FRESH_BUNDLE;
let lastPolledAt = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const listeners = new Set<() => void>();

function emit(next: UpdateSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Asks the server once. NEVER THROWS: this is a banner, and a failed poll
 * leaves the previous answer standing rather than clearing it. A reader on a
 * flaky connection must not watch the offer appear and disappear.
 */
async function poll(): Promise<void> {
  lastPolledAt = Date.now();
  try {
    const response = await fetch(BUILD_ENDPOINT, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const parsed = buildInfoSchema.safeParse(await response.json());
    if (!parsed.success) return;
    freshness = observeServerBuild({ state: freshness, serverSha: parsed.data.sha, bundleSha: BUILD.sha });
    emit({ bundleStale: freshness.isStale });
  } catch {
    // Offline, a blocked request, or a body that is not JSON. All three mean
    // "no new evidence", which is what leaving the snapshot alone says.
  }
}

/** Polls if the tab is visible and the last poll is older than the interval. */
function pollIfDue(): void {
  if (document.hidden) return;
  if (Date.now() - lastPolledAt < POLL_INTERVAL_MS) return;
  void poll();
}

function onVisibilityChange(): void {
  pollIfDue();
}

/**
 * Starts polling on the first subscriber and stops on the last.
 *
 * Passed straight to `useSyncExternalStore`, so the lifetime is the lifetime of
 * the components that care. A page with no update surface on it polls nothing.
 */
export function subscribeUpdateStatus(listener: () => void): () => void {
  const isFirst = listeners.size === 0;
  listeners.add(listener);
  if (isFirst) {
    void poll();
    pollTimer = setInterval(pollIfDue, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

export function getUpdateSnapshot(): UpdateSnapshot {
  return snapshot;
}

export function getServerUpdateSnapshot(): UpdateSnapshot {
  return SERVER_SNAPSHOT;
}

/** What the ribbon says, or that it says nothing. */
export type RibbonState = 'none' | 'newer-bundle';

/**
 * Decides the ribbon from the snapshot. Pure, so
 * `tests/unit/update-ribbon-state.test.ts` can cover it with no DOM.
 *
 * One state today and a union rather than a boolean, because the ribbon is one
 * row with one sentence in it: whatever else it ever has to say has to be
 * chosen HERE, where the choice can be tested, and never in the JSX.
 */
export function ribbonState(current: UpdateSnapshot): RibbonState {
  if (current.bundleStale) return 'newer-bundle';
  return 'none';
}
