/**
 * paused-ribbon-state.ts, what the "sync is paused" ribbon says, decided outside
 * the JSX. Pure: plain values in, a plain verdict out.
 *
 * Same split as `ribbonState` for the update ribbon. The component renders what
 * it is handed, and the CHOICE lives here, so the quiet cases (the ones where the
 * ribbon must say nothing) can be checked without a DOM.
 *
 * TWO STATES, NEITHER OF THEM AN ERROR.
 *
 *   `expired`        the session ended. Sync is paused, the device still holds the
 *                    account's data, and the way out is to sign in again. Shown
 *                    only while the browser is online: offline there is no
 *                    sign-in to do, and the offline shell must stay calm.
 *   `other-account`  somebody ELSE is signed in on a device holding another
 *                    account's data. Shown only when the root answer is LIVE (the
 *                    server named the user just now) and names an account other
 *                    than the hint's. The offline fallback answer is built from
 *                    the hint itself, so it can never prove a mismatch.
 *
 * It reads the hint's pause and nothing else about the hint. It grants nothing.
 */
import type { SignedInHint } from '#app/lib/auth/signed-in-hint';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import { parseOfflineNext } from '#app/lib/auth/safe-next';

/** What {@link resolvePausedRibbon} reads. */
export interface PausedRibbonInputs {
  /** The stored signed-in hint, or `null` for none. */
  hint: SignedInHint | null;
  /** Whether the browser reports a connection. */
  isOnline: boolean;
  /** The id the root data named, or `null` for nobody. */
  rootUserId: number | null;
  /** Whether the root data is the client's offline fallback rather than a server answer. */
  isOfflineFallback: boolean;
}

/** What the ribbon shows. One literal per member, so each narrows on its own. */
export type PausedRibbonState =
  | { kind: 'none' }
  | { kind: 'expired' }
  | { kind: 'other-account'; hintUserId: number; rootUserId: number };

/**
 * Decide which ribbon, if any, to draw.
 *
 * @param inputs The hint, the connectivity flag and what the root data said.
 * @returns `none`, `expired`, or `other-account` with the two accounts involved.
 */
export function resolvePausedRibbon({
  hint,
  isOnline,
  rootUserId,
  isOfflineFallback,
}: PausedRibbonInputs): PausedRibbonState {
  if (hint?.pause === undefined) return { kind: 'none' };

  if (hint.pause.reason === 'expired') {
    return isOnline ? { kind: 'expired' } : { kind: 'none' };
  }

  if (isOfflineFallback || rootUserId === null || rootUserId === hint.userId) return { kind: 'none' };
  return { kind: 'other-account', hintUserId: hint.userId, rootUserId };
}

/** Where the offline page's own `next` falls back to when it is missing or refused. */
const HOME_PATH = '/';

/** The offline page, whose own `next` names the screen the reader was really on. */
const OFFLINE_PATH = '/offline';

/**
 * The sign-in link for the expired ribbon.
 *
 * `next` is the screen the reader is on, so signing in lands them back on it. On
 * `/offline` that screen is the page's own `next` parameter, because the offline
 * page is where a failed navigation parked them, not where they were going. A
 * missing or refused `next` falls back to the home page. `parseOfflineNext`
 * decides what is acceptable: a same-origin path only, and never an account door
 * or the offline page itself. `/sign-in` validates `next` again on its side.
 *
 * @param location The current `pathname` and `search`.
 * @returns A `/sign-in?next=...` path.
 */
export function signInHref({ pathname, search }: { pathname: string; search: string }): string {
  const target =
    pathname === OFFLINE_PATH ?
      (parseOfflineNext(new URLSearchParams(search).get('next')) ?? HOME_PATH)
    : `${pathname}${search}`;
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(target)}`;
}
