/**
 * use-is-offline.ts, whether the browser says it has no connection right now.
 *
 * It exists for the buttons that would POST to the app server: "Ask the AI", the
 * explanation request and the retry. A fetcher whose request cannot leave the
 * device rejects with a network error, and an error a fetcher raises is handed to
 * the nearest error boundary, which replaces the whole screen. Those buttons ask
 * this hook first and draw a calm line instead.
 *
 * `useSyncExternalStore` takes a server snapshot of `false`, so the server render
 * and the first client render agree, and the real value arrives after hydration.
 * `navigator.onLine` can say "online" while the network is dead, which is why the
 * root and search loaders also treat a `TypeError` as unreachable. This hook only
 * covers the common case, the airplane switch.
 */
import { useSyncExternalStore } from 'react';

/** Calls back when the browser's connectivity flag may have changed. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** The client snapshot. Only an explicit `false` means offline. */
function readSnapshot(): boolean {
  return globalThis.navigator?.onLine === false;
}

/** The server snapshot, and the first client render's: online. */
function readServerSnapshot(): boolean {
  return false;
}

/** Whether the browser reports no connection. Re-renders when that changes. */
export function useIsOffline(): boolean {
  return useSyncExternalStore(subscribe, readSnapshot, readServerSnapshot);
}
