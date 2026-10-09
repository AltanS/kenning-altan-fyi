/**
 * erase-other-account.ts, the one way to remove another account's data from this
 * device so the account signed in now can sync into it.
 *
 * WHEN IT RUNS. Somebody signed in on a device whose store holds a DIFFERENT
 * account's lists. Sync is paused (`other-account`), nothing is lost, and the
 * ribbon offers "Erase it". This is what that button does, after the reader has
 * confirmed in a dialog. It is the only code that removes a device's data for a
 * reason other than sign-out, and it never runs on its own: a 401, a 412 and a
 * redirect all leave the data where it is.
 *
 * THE ORDER, AND WHY
 *   1. Drop the sync session, so no trigger starts a cycle mid-wipe.
 *   2. `wipeDeviceStore()`, the same wipe sign-out uses. It stops the persisters
 *      before it deletes anything, which is the whole fix its header describes;
 *      nothing here repeats that.
 *   3. Check the wipe. Both databases must be gone. A delete still blocked by
 *      another open tab returns fewer names, and carrying on would leave the
 *      other account's data in place under a hint that says it is gone. So it
 *      stops, says `blocked`, and leaves the hint exactly as it was.
 *   4. Forget the old account's sync bookkeeping (its last agreed blob version),
 *      which describes a document this device no longer holds.
 *   5. Replace the hint with the new account, with no pause.
 *
 * The caller reloads the page afterwards, so the app boots on an empty store and
 * the new account's document is pulled into it.
 */
import { replaceSignedInHint } from '#app/lib/auth/signed-in-hint';
import { OUTBOX_DB_NAME, PRIMARY_DB_NAME, wipeDeviceStore } from '#app/lib/local-store';
import { clearSyncSession } from '#app/lib/sync/sync-session';
import { createSyncStateStore, deviceStorage, type KeyValueStorage } from '#app/lib/sync/sync-state';

/** The two databases that make up a device's store. Both must be deleted. */
const DEVICE_DATABASES: readonly string[] = [PRIMARY_DB_NAME, OUTBOX_DB_NAME];

/** How the erase ended. One literal per member. */
export type EraseOutcome = 'erased' | 'blocked';

/** What {@link eraseOtherAccountData} needs, and the seams a test replaces. */
export interface EraseOtherAccountOptions {
  /** The account whose data the device holds now. */
  oldUserId: number;
  /** The account signed in now, which the device will hold data for afterwards. */
  newUserId: number;
  /** The wipe. Left out, `wipeDeviceStore`. Returns the names of the databases it deleted. */
  wipe?: () => Promise<string[]>;
  /** Where the sync bookkeeping lives. Left out, the device's own storage. */
  syncStateStorage?: KeyValueStorage;
}

/**
 * Erase the other account's data and hand the device to the account signed in.
 *
 * @returns `erased` when both databases are gone and the hint now names the new
 *   account, or `blocked` when they are not, in which case nothing else changed.
 */
export async function eraseOtherAccountData({
  oldUserId,
  newUserId,
  wipe = wipeDeviceStore,
  syncStateStorage = deviceStorage(),
}: EraseOtherAccountOptions): Promise<EraseOutcome> {
  clearSyncSession();

  const deleted = await wipe();
  if (!DEVICE_DATABASES.every((name) => deleted.includes(name))) return 'blocked';

  createSyncStateStore({ storage: syncStateStorage, userId: oldUserId }).clear();
  replaceSignedInHint(newUserId);
  return 'erased';
}
