import { useEffect } from 'react';
import { useNavigation, useRevalidator } from 'react-router';

import { ROOM_LIST_REFRESH_MS } from '#app/lib/rooms/limits';

/**
 * Read the rooms list again while a room is being built, and at once when the
 * reader returns to the tab. A read never starts a build.
 *
 * A hidden tab and an offline device ask nothing: a failed read would replace
 * the screen with an error. No read starts while a navigation or an earlier read
 * is still running.
 */
export function usePendingRoomsRefresh(hasPending: boolean): void {
  const { revalidate, state } = useRevalidator();
  const navigation = useNavigation();
  const isBusy = state !== 'idle' || navigation.state !== 'idle';

  useEffect(() => {
    if (!hasPending || isBusy) return;
    const refresh = (): void => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      void revalidate();
    };
    const timer = setInterval(refresh, ROOM_LIST_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [hasPending, isBusy, revalidate]);
}
