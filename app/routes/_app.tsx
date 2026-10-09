import { useEffect } from 'react';
import { Outlet, useRouteLoaderData } from 'react-router';
import AppWrapper from '#app/components/app-wrapper';
import { useIsOffline } from '#app/hooks/use-is-offline';
import { useSignedInHint } from '#app/hooks/use-signed-in-hint';
import { confirmSignedInHint } from '#app/lib/auth/signed-in-hint';
import { startSyncScheduler } from '#app/lib/sync/scheduler';
import { decideSyncSession } from '#app/lib/sync/sync-decision';
import { clearSyncSession, getSyncSession, setSyncSession } from '#app/lib/sync/sync-session';

/** The two root fields this layout reads. */
interface RootSyncData {
  userId: number | null;
  isOfflineFallback: boolean;
}

/**
 * The layout every in-app screen sits in: sidebar at md and up, drawer plus tab
 * bar below it. The header title comes from the nav catalog, so a screen only
 * passes a title when it needs one the catalog does not carry.
 *
 * THE SYNC TRIGGERS START HERE, and not in `root.tsx`. This is the shell the
 * screens that read the local store sit in, so starting the scheduler here
 * gives it exactly that lifetime. The public and auth layouts read nothing
 * local, and there is no reason for them to hold a store listener or a window
 * event handler.
 *
 * IT COSTS AN ANONYMOUS VISITOR NOTHING. `startSyncScheduler` returns a no-op
 * during SSR, and checks for a sync session at every trigger, so a visitor who
 * never signs up subscribes to nothing and issues no request. That is the
 * product rule this app is built on: an account is an opt-in, and nothing on
 * the search, lists, history or entry path may require one.
 *
 * The scheduler effect has an EMPTY dependency list on purpose. Anything that
 * changes per navigation would tear the listeners down and rebuild them on every
 * route change, which turns a debounced burst of edits into a queue of
 * half-settled ones.
 *
 * ── THE TWO EFFECTS BELOW, IN THIS ORDER ─────────────────────────────────
 *
 * 1. CONFIRM. Each time the root loader answers, a live answer that names a user
 *    is checked against the signed-in hint (`confirmSignedInHint`). That is the
 *    only place the hint is written from a server answer: it adopts the first
 *    account, clears a pause when the SAME account signs in again, and pauses
 *    sync when a DIFFERENT account signs in on a device holding someone else's
 *    data. It depends on the root data object, which is new per loader answer, so
 *    a `401` from the sync endpoint (which changes no root data) cannot loop
 *    through it. An offline fallback answer is skipped: its `userId` came from
 *    the hint, and a hint cannot confirm itself.
 *
 * 2. SESSION. The sync session is installed from `decideSyncSession`, the one
 *    function that weighs the root answer, the connectivity flag and the hint.
 *    It runs again whenever the decision's kind or user changes, so a fresh
 *    sign-in pulls immediately (`setSyncSession` notifies the scheduler's own
 *    listener) and a pause or a sign-out drops the session. Re-installing the
 *    same session would re-notify the scheduler and start a redundant cycle on
 *    every root revalidation, and every client action revalidates root (see
 *    `root.tsx`'s clientLoader), so an unchanged user is left alone.
 *
 * The hint is read through `useSignedInHint`, so a pause the scheduler writes
 * re-renders this layout and the decision changes in the same tick. Nothing
 * here clears the hint: an expired session pauses sync and keeps the device's
 * data and the offline shell. Only a deliberate sign-out clears it
 * (`app/lib/auth/signed-in-hint.ts`).
 *
 * A DEAD SESSION IS NOT INFERRED FROM A ROOT ANSWER THAT NAMES NOBODY. The
 * cached `/offline` page is signed out on purpose, so "root says nobody" proves
 * nothing about the cookie. The pause comes from the server refusing a sync
 * request.
 */
export default function AppLayout() {
  const rootData = useRouteLoaderData<RootSyncData>('root');
  const hint = useSignedInHint();
  const isOnline = !useIsOffline();
  const decision = decideSyncSession({ rootUserId: rootData?.userId ?? null, isOnline, hint });
  const syncUserId = decision.kind === 'sync' ? decision.userId : null;

  useEffect(() => startSyncScheduler(), []);

  useEffect(() => {
    if (rootData === undefined || rootData.isOfflineFallback || rootData.userId === null) return;
    confirmSignedInHint(rootData.userId);
  }, [rootData]);

  useEffect(() => {
    if (syncUserId === null) {
      clearSyncSession();
      return;
    }
    if (getSyncSession()?.userId === syncUserId) return;
    setSyncSession({ userId: syncUserId });
  }, [syncUserId]);

  return (
    <AppWrapper>
      <Outlet />
    </AppWrapper>
  );
}
