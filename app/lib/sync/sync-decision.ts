/**
 * sync-decision.ts, the one place that answers "may this page sync, and for
 * whom?". Pure: it reads three plain values and writes nothing.
 *
 * WHY IT IS A FUNCTION OF THREE THINGS. The page knows what the last root answer
 * named (`rootUserId`), whether the browser reports a connection (`isOnline`),
 * and what the signed-in hint says (`hint`). The hint holds the account whose
 * data this device's store carries, and it may pause sync. None of the three is
 * a credential: the server checks the cookie on every request, so the worst a
 * wrong answer here can do is start a request the server refuses or hold one
 * back.
 *
 * THE ORDER IS THE DESIGN.
 *   1. No hint: `none`. Nothing is known about whose data the device holds.
 *      The confirm step in `_app.tsx` writes a hint when a live root answer
 *      names a user, and that store change decides again.
 *   2. A pause on the hint: `paused`, with its reason. A pause is lifted only by
 *      the confirm step (the same account signed in again) or by erasing the
 *      other account's data, never by this function.
 *   3. A root answer that names somebody OTHER than the hint's account: `paused`
 *      as `other-account`. This is computed and never written here, so the
 *      first render after a different account signs in already holds sync back,
 *      before the confirm step has written the pause.
 *   4. Otherwise sync for the hint's account, when somebody is effectively
 *      signed in: the root answer names them, or the browser is offline and the
 *      hint stands in. Online with a root answer that names nobody is `none`:
 *      the cached `/offline` page is signed out on purpose, and an expired
 *      session is not inferred from it.
 *
 * It never returns a user other than `hint.userId`: the store holds that
 * account's data, and that is the only account it may sync.
 */
import type { SignedInHint, SyncPauseReason } from '#app/lib/auth/signed-in-hint';

/** What {@link decideSyncSession} reads. */
export interface SyncDecisionInputs {
  /** The id the root data named, or `null` for nobody. */
  rootUserId: number | null;
  /** Whether the browser reports a connection. */
  isOnline: boolean;
  /** The stored signed-in hint, or `null` for none. */
  hint: SignedInHint | null;
}

/** What the page should do about sync. One literal per member, so each narrows on its own. */
export type SyncDecision =
  | { kind: 'sync'; userId: number }
  | { kind: 'paused'; reason: SyncPauseReason }
  | { kind: 'none' };

/**
 * Decide whether and for whom the page syncs.
 *
 * @param inputs The root data's id, the connectivity flag and the stored hint.
 * @returns `sync` with the account to sync, `paused` with why not, or `none`.
 */
export function decideSyncSession({ rootUserId, isOnline, hint }: SyncDecisionInputs): SyncDecision {
  if (hint === null) return { kind: 'none' };
  if (hint.pause !== undefined) return { kind: 'paused', reason: hint.pause.reason };
  if (rootUserId !== null && rootUserId !== hint.userId) return { kind: 'paused', reason: 'other-account' };

  const effectiveUserId = rootUserId ?? (isOnline ? null : hint.userId);
  if (effectiveUserId === null) return { kind: 'none' };
  return { kind: 'sync', userId: hint.userId };
}
