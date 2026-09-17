/**
 * "Is the page I am looking at older than the one this server now serves?"
 *
 * The browser asks `/api/build` what THIS server is running and compares the
 * commit it answers with against the commit compiled into this bundle. A newer
 * bundle is one reload away, which is what makes this question worth asking at
 * all: the answer comes with a button that changes something.
 *
 * There is deliberately no second question about published releases. Kenning
 * publishes no version releases, so a line saying "a newer release exists"
 * would be reporting on something that does not exist.
 *
 * ── WHY TWO MISMATCHES AND NOT ONE ──────────────────────────────────────────
 *
 * Bay pulls one image and restarts the container, and for a few seconds around
 * that restart a tab can be answered by the old process, then the new one, then
 * the old one again. Acting on the first mismatch offers a reload to a reader
 * who would land on the build they are already running, and the offer comes
 * back on the next poll. Requiring two consecutive mismatches costs one poll
 * interval and removes the whole class of flapping.
 *
 * A match resets the count outright, so the two have to be consecutive rather
 * than merely two in a session.
 *
 * ── UNKNOWN IS NOT A MISMATCH ───────────────────────────────────────────────
 *
 * Either side can be `unknown`: a build with no git and no override stamps that
 * word. An unknown commit is an absence of evidence, so it resets rather than
 * accumulating. Without that rule an unstamped build would nag about an update
 * on its second poll, every time.
 *
 * Pure and exported for `tests/unit/bundle-freshness.test.ts`; the state lives
 * in `update-store.ts`.
 */
import { UNKNOWN_SHA } from '#app/lib/build-info';

/** How many consecutive mismatches make a bundle stale. */
export const STALE_AFTER_MISMATCHES = 2;

/** What the freshness check remembers between polls. */
export interface BundleFreshness {
  /** Consecutive polls that saw a different server commit. */
  mismatches: number;
  /** Whether the page should now offer a reload. */
  isStale: boolean;
}

/** No evidence yet: the starting value, and what a match returns to. */
export const FRESH_BUNDLE: BundleFreshness = { mismatches: 0, isStale: false };

/** Whether a sha carries any information at all. */
function isKnownSha(sha: string | null): sha is string {
  return sha !== null && sha !== '' && sha !== UNKNOWN_SHA;
}

/**
 * Folds one observation of the server's commit into the running count.
 *
 * @param state - the previous result, `FRESH_BUNDLE` on the first poll.
 * @param serverSha - what `/api/build` answered, or null when it did not.
 * @param bundleSha - this bundle's own commit (`BUILD.sha`).
 */
export function observeServerBuild({
  state,
  serverSha,
  bundleSha,
}: {
  state: BundleFreshness;
  serverSha: string | null;
  bundleSha: string;
}): BundleFreshness {
  if (!isKnownSha(serverSha) || !isKnownSha(bundleSha)) return FRESH_BUNDLE;
  if (serverSha === bundleSha) return FRESH_BUNDLE;
  const mismatches = state.mismatches + 1;
  return { mismatches, isStale: mismatches >= STALE_AFTER_MISMATCHES };
}
