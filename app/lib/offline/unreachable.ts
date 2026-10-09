/**
 * unreachable.ts, one answer to "could the app server not be reached?".
 *
 * THREE SCREENS ASK THIS QUESTION and they must agree. The search route's
 * `clientLoader` asks it to decide whether to answer from the device, the gated
 * layout's `ErrorBoundary` asks it to decide between a calm card and the parent
 * boundary, and the root `clientLoader` asks it next to `shouldFallbackOffline`.
 * Three copies of the rule would drift, and the visible symptom would be a
 * screen that is calm in one place and crashes in the next.
 *
 * WHAT COUNTS AS UNREACHABLE
 *   1. The browser says it is offline. Nothing else needs to be true.
 *   2. A `TypeError`. A failed `fetch` rejects with one before any HTTP status
 *      exists, and the service worker answers a `.data` request with a network
 *      error while offline, which arrives the same way. A service worker that
 *      TIMES OUT is not told apart from this on purpose: the reader sees the
 *      same thing in both cases, a server that did not answer.
 *   3. A thrown `ErrorResponse` (or a `Response`) with status 502, 503 or 504.
 *      Those are the three statuses a proxy answers for an app that is down or
 *      restarting, and they say nothing about the request being wrong.
 *
 * WHAT DOES NOT COUNT, AND MUST NOT. A 401 is a session that ended, a 500 is a
 * bug, and a redirect is the server answering correctly. Treating any of them as
 * "offline" would hide a real fault behind a calm screen, or worse, keep a reader
 * on a stale page after their session ended.
 *
 * PURE ON PURPOSE. The only impure input is the connectivity flag, and a caller
 * can pass it, so the unit tests need no browser.
 */
import { isRouteErrorResponse } from 'react-router';

/** The statuses a gateway answers when the application behind it cannot be reached. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** What {@link isServerUnreachable} can be told instead of asking the browser. */
export interface ServerUnreachableOptions {
  /**
   * Whether the browser reports a connection. Left out, `navigator.onLine` is
   * read, and a missing `navigator` (a server render) counts as online.
   */
  isOnline?: boolean;
}

/**
 * Whether the browser says it has no connection.
 *
 * Only an explicit `false` counts. `navigator.onLine` is `undefined` in Node,
 * and reading that as "offline" would make every server-side caller unreachable.
 */
function readBrowserIsOffline(): boolean {
  return globalThis.navigator?.onLine === false;
}

/**
 * Decide whether a failure means the app server could not be reached.
 *
 * @param cause Whatever was thrown: a `TypeError`, a router `ErrorResponse`, a
 *   `Response`, or anything else. It is only inspected, never rethrown here.
 * @param options Pass `isOnline` to decide without asking the browser.
 * @returns True when the reader is offline or the server did not answer.
 */
export function isServerUnreachable(cause: unknown, options: ServerUnreachableOptions = {}): boolean {
  const isOffline = options.isOnline === undefined ? readBrowserIsOffline() : !options.isOnline;
  if (isOffline) return true;
  if (cause instanceof TypeError) return true;
  if (isRouteErrorResponse(cause)) return GATEWAY_STATUSES.has(cause.status);
  if (cause instanceof Response) return GATEWAY_STATUSES.has(cause.status);
  return false;
}
