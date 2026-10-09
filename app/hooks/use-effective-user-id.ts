/**
 * use-effective-user-id.ts, "is somebody signed in?" for the controls that only
 * need to DRAW, answered the same way everywhere.
 *
 * THE PROBLEM. The root data names the signed-in user, and the shell reads it to
 * decide whether to draw the sidebar rows, the bottom tabs and the favourite
 * star. Offline, the root data can be a stale signed-out embed: the page came
 * from the service worker's cache, and no server was asked. The reader is still
 * signed in, their device still holds their words, and a shell that drops every
 * tab the moment the network goes is wrong in the direction that hurts.
 *
 * THE ANSWER. While the browser says it is OFFLINE, a missing root id falls back
 * to the display-only hint (`signed-in-hint.ts`). While it says it is online the
 * hint is ignored completely, so an online signed-out visitor sees exactly what
 * they always saw. Every caller goes through this one hook so the sidebar, the
 * drawer, the bottom tabs and the star cannot disagree.
 *
 * IT DRAWS AND IT GATES NOTHING. Same rule as the hint: `accountMiddleware` and
 * the server loaders decide who may do anything. The value here picks which
 * links to show.
 *
 * IT DOES NOT DECIDE SYNC. The sync session used to be installed from this value.
 * It is installed from `decideSyncSession` (`app/lib/sync/sync-decision.ts`) now,
 * which also reads the hint's pause. A PAUSED HINT STILL DRAWS THE SHELL here:
 * the data on the device is still there to read, and a paused sync is not a
 * reason to take the sidebar away.
 *
 * SERVER AND FIRST CLIENT RENDER AGREE. The hint lives in `localStorage` and the
 * connectivity flag in `navigator`, neither of which exists while the server
 * renders. `useSyncExternalStore` takes a separate server snapshot (`null`) and
 * switches to the real one after hydration, so there is no hydration mismatch.
 */
import { useSyncExternalStore } from 'react';
import { useRouteLoaderData } from 'react-router';
import { readSignedInHint, subscribeSignedInHint } from '#app/lib/auth/signed-in-hint';

/** What {@link offlineHintUserId} reads. */
export interface OfflineHintInputs {
  /** Whether the browser reports a connection. */
  isOnline: boolean;
  /** The id in the signed-in hint, or `null` for no hint. */
  hintUserId: number | null;
}

/**
 * The hint's user id, but only while the browser is offline.
 *
 * @param inputs The connectivity flag and the stored hint.
 * @returns The hint's id while offline, `null` while online or with no hint.
 */
export function offlineHintUserId({ isOnline, hintUserId }: OfflineHintInputs): number | null {
  return isOnline ? null : hintUserId;
}

/** What {@link resolveEffectiveUserId} reads. */
export interface EffectiveUserIdInputs {
  /** The id the root data named, or `null` for nobody. */
  rootUserId: number | null;
  /** {@link offlineHintUserId} for this moment. */
  offlineHintUserId: number | null;
}

/**
 * The id the shell should draw for.
 *
 * @param inputs The root data's id and the offline hint.
 * @returns The root's id when it names somebody, otherwise the offline hint.
 */
export function resolveEffectiveUserId({ rootUserId, offlineHintUserId: hintUserId }: EffectiveUserIdInputs): number | null {
  return rootUserId ?? hintUserId;
}

/**
 * Calls back when the connectivity flag or the stored hint may have changed.
 *
 * The hint half goes through `subscribeSignedInHint`, which also reports a write
 * made in THIS tab. The bare `storage` event it replaced fires in the other tabs
 * only, so a pause or a replaced hint written here would never have redrawn the
 * shell.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  const stopHint = subscribeSignedInHint(onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
    stopHint();
  };
}

/** The client snapshot. Cheap while online: the hint is not even read. */
function readSnapshot(): number | null {
  const isOnline = globalThis.navigator?.onLine !== false;
  return offlineHintUserId({ isOnline, hintUserId: isOnline ? null : (readSignedInHint()?.userId ?? null) });
}

/** The server snapshot, and the one a hydrating client uses: nobody. */
function readServerSnapshot(): number | null {
  return null;
}

/**
 * The signed-in user id for DRAWING, offline-aware.
 *
 * @returns The root data's id, else the hint's id while offline, else `null`.
 */
export function useEffectiveUserId(): number | null {
  const rootData = useRouteLoaderData<{ userId: number | null }>('root');
  const hintUserId = useSyncExternalStore(subscribe, readSnapshot, readServerSnapshot);
  return resolveEffectiveUserId({ rootUserId: rootData?.userId ?? null, offlineHintUserId: hintUserId });
}
