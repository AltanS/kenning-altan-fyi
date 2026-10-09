/**
 * session-pause.ts, what the page does when a sync request is refused because
 * of WHO is asking.
 *
 * Two refusals mean "this device may not sync right now" and neither means
 * "delete anything":
 *
 *   - `unauthorized` (401): the session cookie is gone or stale. The data on the
 *     device is still this account's. Sync pauses as `expired`; signing in again
 *     as the same account resumes it.
 *   - `account-mismatch` (412): the cookie names a different account from the
 *     one whose data this page was about to push. Sync pauses as
 *     `other-account`; nothing from one account may reach the other.
 *
 * Before this module the 401 handling lived in `withSignedOutCheck`
 * (`sync-client.ts`), which the scheduler never called, so a dead session
 * repeated its 401 on every focus, `online` and local edit. Every caller that
 * runs a cycle now goes through here.
 *
 * ORDER: the session is cleared first, so no trigger can start another request
 * while the pause is being written, and the pause second. The hint is never
 * cleared here. Only a deliberate sign-out does that (`signed-in-hint.ts`).
 */
import { readSignedInHint, setSyncPause } from '#app/lib/auth/signed-in-hint';
import { isSyncRequestError } from '#app/lib/sync/sync-error';
import { clearSyncSession } from '#app/lib/sync/sync-session';

/**
 * Pause sync when a failure says this device may not sync.
 *
 * @param cause Whatever a sync call threw.
 * @returns `true` when the failure was an auth refusal and has been handled, so
 *   the caller must neither report nor retry it. `false` for anything else.
 */
export function pauseSyncOnAuthFailure(cause: unknown): boolean {
  if (!isSyncRequestError(cause)) return false;

  if (cause.kind === 'unauthorized') {
    clearSyncSession();
    // An `other-account` pause is the stronger statement: the data here is not
    // the account that just lost its session, so a 401 must not downgrade it.
    if (readSignedInHint()?.pause?.reason !== 'other-account') setSyncPause('expired');
    return true;
  }

  if (cause.kind === 'account-mismatch') {
    clearSyncSession();
    setSyncPause('other-account');
    return true;
  }

  return false;
}
