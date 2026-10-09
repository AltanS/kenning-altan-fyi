/**
 * How the offline page takes the reader back to the screen they asked for.
 *
 * `navigator.onLine` is never proof of a working network. A phone on Wi-Fi with
 * no internet, a VPN interface and a captive portal all report `true` while
 * nothing answers. So the page asks the server itself, with a small probe, and
 * decides from the answer. The decision is a pure function so a test can feed
 * it plain data.
 */

/** The public, uncacheable route the probe asks. The worker lets it through untouched. */
export const PROBE_PATH = '/api/build';

/** How long the probe waits. A reader on a dead network must not stare at the card for long. */
export const PROBE_TIMEOUT_MS = 2500;

export type ReturnPath =
  /** The server does not answer: a client-side navigation, so the screen's own client loaders decide. */
  | 'client-navigate'
  /** The server answers: a full page load, which also replaces the stale root data in the cached document. */
  | 'full-load'
  /** The server answers but the last automatic return was under a minute ago: a loop, so do nothing. */
  | 'stay';

export interface ReturnPathInput {
  /** What `navigator.onLine` said. Not trusted when it says `true`. */
  isOnLine: boolean;
  /** Whether the probe got an ok response. `false` also when the probe was skipped. */
  isProbeOk: boolean;
  /** Whether this page already sent the reader back by itself in the last minute. */
  hasBouncedRecently: boolean;
}

export function chooseReturnPath({ isOnLine, isProbeOk, hasBouncedRecently }: ReturnPathInput): ReturnPath {
  const isReachable = isOnLine && isProbeOk;
  if (!isReachable) return 'client-navigate';
  if (hasBouncedRecently) return 'stay';
  return 'full-load';
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Whether the server answered with a success status before the timeout.
 * Any failure counts as "not reachable": a rejected fetch, an abort and a
 * non-ok status. It never throws.
 */
export async function probeServer({ fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS }: ProbeOptions = {}): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(PROBE_PATH, { cache: 'no-store', signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
