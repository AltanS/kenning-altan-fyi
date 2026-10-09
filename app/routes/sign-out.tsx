/**
 * `/sign-out`. A POST, and the only route in this app that deletes local data.
 *
 * ── Why it is POST only ───────────────────────────────────────────────────
 *
 * A GET that signs you out is a URL anybody can put in an image tag, and it is
 * also a URL a link prefetcher can visit. The loader here answers a GET with a
 * redirect to the home page and changes nothing; the action is the sign-out.
 *
 * ── The wipe, and why it is a `clientAction` ──────────────────────────────
 *
 * Sign-out has to leave the device empty, so the next person on a shared phone
 * does not open somebody else's vocabulary lists. The data lives in two
 * IndexedDB databases, which only the browser can delete, so the order has to
 * be driven from the client:
 *
 *   1. one sync attempt, so the last local edits reach the account,
 *   2. drop the sync session, so no trigger starts a cycle mid-wipe,
 *   3. stop the persisters and delete both databases (`wipeDeviceStore`),
 *   4. call the server action, which destroys the cookie and redirects.
 *
 * The service worker is not asked to clear anything. It used to cache signed-in
 * HTML such as `/account`, which carries the reader's address, and sign-out had
 * to drop it. It now caches only the build's files and the signed-out
 * `/offline` page, so there is no user HTML on the device to remove.
 *
 * The server step is LAST on purpose. Step 1 needs the cookie the server is
 * about to destroy, and step 3 must not be cut short by the redirect the
 * server answers with: `serverAction()` throws that redirect, so nothing after
 * it in this function would run.
 *
 * STEP 3 STOPS THE PERSISTERS BEFORE IT DELETES ANYTHING, and the order inside
 * it matters as much as the order out here: a delete with the auto-load poll
 * still running is undone by that poll a second later. `wipe.ts` carries the
 * full account.
 *
 * ── When the data on the device is not the signing-out account's ──────────
 *
 * The signed-in hint names the account whose data the device holds. When it
 * carries an `other-account` pause, somebody signed in on a device that holds
 * ANOTHER account's lists, and the stored data is not theirs to send or to
 * delete. That branch skips the final sync (it would push the other account's
 * lists into this one's document) and skips the wipe (it would destroy lists
 * the other account never synced), records `expired` so the pause survives the
 * sign-out, and runs the server action. The original account signing back in
 * finds its data and resumes sync. The ribbon's "Erase it" is the only thing
 * that removes that data.
 *
 * THE CHECK HAPPENS BEFORE AND AFTER THE FINAL SYNC. The hint may carry no pause
 * yet while the cookie belongs to another account. Then the final sync is the
 * first request to find out: the server answers 412 `account-mismatch` and the
 * sync client records the `other-account` pause. So the hint is read again once
 * the sync has returned, and the same branch runs. Without the second read the
 * wipe would destroy lists that belong to the other account and were never
 * synced. Both checks end in one function so the two paths cannot drift.
 *
 * A FAILED SYNC DOES NOT BLOCK THE SIGN-OUT. Somebody on a train tapping sign
 * out must be signed out. The edits stay in the device's outbox until the
 * wipe removes it, which is the honest trade: the alternative is refusing to
 * sign out on a bad connection.
 */
import { redirect } from 'react-router';

import type { Route } from './+types/sign-out';
import { clearSignedInHint, readSignedInHint, setSyncPause } from '#app/lib/auth/signed-in-hint';
import { wipeDeviceStore } from '#app/lib/local-store';
import { clearSyncSession } from '#app/lib/sync/sync-session';
import { syncNow } from '#app/components/account/sync-client';
import { isSyncRequestError, type SyncErrorKind } from '#app/lib/sync/sync-error';
import { reportError } from '#app/lib/report-error';
import { destroyUserSession } from '#app/services/session.server';

/** A GET is not a sign-out. Nothing here changes anything. */
export function loader(): Response {
  return redirect('/');
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  return redirect('/', { headers: { 'Set-Cookie': await destroyUserSession(request) } });
}

export async function clientAction({ serverAction }: Route.ClientActionArgs): Promise<Response> {
  if (holdsAnotherAccountsData()) return signOutKeepingTheData(serverAction);

  await carryLastEditsUp();
  // The final sync is what finds out that the cookie is another account's.
  if (holdsAnotherAccountsData()) return signOutKeepingTheData(serverAction);

  clearSyncSession();
  clearSignedInHint();
  await wipeDeviceStore();
  return serverAction();
}

/** True when the hint says the stored data belongs to an account other than the signed-in one. */
function holdsAnotherAccountsData(): boolean {
  return readSignedInHint()?.pause?.reason === 'other-account';
}

/**
 * The sign-out for a device that holds somebody else's data.
 *
 * No final sync, no wipe, no hint clear: the stored data belongs to somebody
 * else. `expired` replaces the reason because the signed-in account is gone now,
 * and the device still holds the other one's data.
 */
function signOutKeepingTheData(serverAction: Route.ClientActionArgs['serverAction']): Promise<Response> {
  clearSyncSession();
  setSyncPause('expired');
  return serverAction();
}

/**
 * The failures that are the ordinary case for a device being put away: no
 * network, a session that already ended, and another account's cookie (the
 * sync client has paused sync for that one).
 */
const ABSORBED_KINDS: ReadonlySet<SyncErrorKind> = new Set(['transport', 'unauthorized', 'account-mismatch']);

/**
 * One last cycle, with every failure absorbed.
 *
 * Offline, an expired session and a server that is down all land here, and none
 * of them is a reason to keep somebody signed in. A transport failure is not
 * even reported: it is the ordinary case for a device being put away.
 */
async function carryLastEditsUp(): Promise<void> {
  try {
    await syncNow();
  } catch (cause) {
    // A dropped connection or an already-dead session is the ordinary case for
    // a device being put away, and reporting it would bury the failures that
    // mean something. Anything else is unexpected and is worth a line.
    if (isSyncRequestError(cause) && ABSORBED_KINDS.has(cause.kind)) return;
    reportError(cause, { operation: 'sign-out', step: 'finalSync' });
  }
}
