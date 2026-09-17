/**
 * The update subject, as a component sees it.
 *
 * A thin read over `#app/lib/update-store`, which holds the state and the poll,
 * plus the one action, which lives in the service worker. Split that way
 * because the store has to work outside React, and because
 * `useSyncExternalStore` needs a `getServerSnapshot` for the SSR pass.
 *
 * `updateNow` is the only thing here that changes what the reader is looking
 * at, and it can only ever adopt assets this server is ALREADY serving. There
 * is nothing in this app that can upgrade the server, and nothing here pretends
 * otherwise.
 */
import { useSyncExternalStore } from 'react';

import { adoptNewestBundle } from '#app/lib/service-worker';
import {
  getServerUpdateSnapshot,
  getUpdateSnapshot,
  ribbonState,
  subscribeUpdateStatus,
  type RibbonState,
  type UpdateSnapshot,
} from '#app/lib/update-store';

/** The snapshot, the ribbon's verdict, and the one thing a reader can do. */
export interface UpdateStatusView {
  status: UpdateSnapshot;
  ribbon: RibbonState;
  /** Adopt the newest bundle this server serves, then reload onto it. */
  updateNow: () => void;
}

export function useUpdateStatus(): UpdateStatusView {
  const status = useSyncExternalStore(subscribeUpdateStatus, getUpdateSnapshot, getServerUpdateSnapshot);

  return {
    status,
    ribbon: ribbonState(status),
    updateNow: () => {
      void adoptNewestBundle();
    },
  };
}
