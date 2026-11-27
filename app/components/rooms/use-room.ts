import { useEffect, useState } from 'react';
import { useFetcher, useRevalidator } from 'react-router';

import { ROOM_POLL_INTERVAL_MS } from '#app/lib/rooms/limits';
import type { RoomRefusal } from '#app/lib/rooms/request';
import { roomRetryResponseSchema, roomViewSchema, type RoomView } from '#app/lib/rooms/view';

export interface RoomController {
  room: RoomView;
  /** Start another attempt. */
  retry: () => void;
  isRetrying: boolean;
  /** Why the last retry started nothing, or null. */
  refusal: RoomRefusal | null;
}

/**
 * One room on screen: what the loader read, kept current while it is being built.
 *
 * THE POLL IS A GET THAT NEVER ENQUEUES. Only the retry POST starts work.
 */
export function useRoom(loaded: RoomView): RoomController {
  const [room, setRoom] = useState(loaded);
  // A new loader answer (a revalidation, another room) replaces what was polled.
  // In render rather than in an effect, so no frame shows the older one.
  const [seededFrom, setSeededFrom] = useState(loaded);
  if (seededFrom !== loaded) {
    setSeededFrom(loaded);
    setRoom(loaded);
  }

  const { revalidate } = useRevalidator();
  const isPending = room.status === 'pending';
  const roomId = room.id;

  useEffect(() => {
    if (!isPending) return;
    const aborter = new AbortController();
    const timer = setInterval(() => {
      const ask = async (): Promise<void> => {
        const response = await fetch(`/api/rooms/${roomId}`, {
          signal: aborter.signal,
          headers: { accept: 'application/json' },
        });
        // Deleted from another tab: the loader renders the 404.
        if (response.status === 404) {
          await revalidate();
          return;
        }
        // Any other non-2xx is "ask again next tick", never a failed room.
        if (!response.ok) return;
        const polled = roomViewSchema.safeParse(await response.json());
        if (polled.success) setRoom(polled.data);
      };
      // A poll that could not be made is also "ask again next tick".
      void ask().catch(() => undefined);
    }, ROOM_POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      aborter.abort();
    };
  }, [isPending, roomId, revalidate]);

  // The retry's own answer is read for its refusal only. The room it carries
  // arrives through the revalidation that follows every submission.
  const fetcher = useFetcher();
  const answered = roomRetryResponseSchema.safeParse(fetcher.data);

  return {
    room,
    retry: () => {
      void fetcher.submit(null, { method: 'post', action: `/api/rooms/${roomId}/retry` });
    },
    isRetrying: fetcher.state !== 'idle',
    refusal: answered.success ? answered.data.refusal : null,
  };
}
