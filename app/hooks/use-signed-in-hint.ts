/**
 * use-signed-in-hint.ts, the signed-in hint as a component reads it.
 *
 * The hint lives in `localStorage` and changes under the page: the scheduler
 * writes a pause when a sync request is refused, the confirm effect in
 * `_app.tsx` writes it when a live root answer arrives, and another tab can
 * write it too. `useSyncExternalStore` is how a component follows a value like
 * that, and it asks for two things this file is careful about.
 *
 * THE SNAPSHOT IS THE RAW STORED STRING. React compares snapshots with
 * `Object.is` on every render. A string is a stable value, so an unchanged hint
 * costs no re-render; a parsed object would be a new one on every call, and the
 * component would render forever. The parse happens once per distinct string,
 * in `useMemo`.
 *
 * THE SERVER SNAPSHOT IS `null`. There is no `localStorage` while the server
 * renders, and a hydrating client must render the same markup, so both start
 * from "no hint" and the real value arrives right after hydration.
 *
 * Display-only, like the hint itself: nothing here authorises anything.
 */
import { useMemo, useSyncExternalStore } from 'react';

import {
  parseSignedInHint,
  readRawSignedInHint,
  subscribeSignedInHint,
  type SignedInHint,
} from '#app/lib/auth/signed-in-hint';

/** The client snapshot: the stored text, untouched. */
function readSnapshot(): string | null {
  return readRawSignedInHint();
}

/** The server snapshot, and the one a hydrating client uses: no hint. */
function readServerSnapshot(): string | null {
  return null;
}

/**
 * The stored signed-in hint, followed as it changes.
 *
 * @returns The hint, or `null` when there is none, it is unreadable, or the page is rendering on the server.
 */
export function useSignedInHint(): SignedInHint | null {
  const raw = useSyncExternalStore(subscribeSignedInHint, readSnapshot, readServerSnapshot);
  return useMemo(() => parseSignedInHint(raw), [raw]);
}
