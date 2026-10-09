/**
 * signed-in-hint.ts, the one fact the app keeps so the shell can DRAW itself
 * offline: "this browser was last signed in as user N".
 *
 * IT IS DISPLAY-ONLY. It is never a credential, it authorises nothing, and no
 * decision that costs money or reveals data may read it. The session cookie is
 * httpOnly, so script cannot see whether it is still valid, and offline there is
 * no server to ask. Without a hint the root `clientLoader` has to answer "nobody
 * is signed in" when the network is gone, and the sidebar, the bottom tabs and
 * the favourite star all disappear from a reader who is, in fact, still signed
 * in and reading their own device. The hint lets those controls stay where the
 * reader left them. A wrong hint costs a few navigation links that lead to a
 * "this screen needs a connection" card, and the server still refuses everything
 * that needed an account the moment a request reaches it.
 *
 * WHAT IT HOLDS: `{ userId }` and nothing else. The address, the name and every
 * flag stay on the server.
 *
 * WHO WRITES IT: `_app.tsx`, when the root data names a user. WHO CLEARS IT:
 * `sign-out.tsx`'s `clientAction`, the sync client when the server answers a
 * 401, and `_app.tsx` when the root data says nobody is signed in while the
 * browser is online.
 *
 * SSR-SAFE AND NEVER THROWING. `localStorage` does not exist during a server
 * render, and in a browser it can throw on access (blocked storage, a private
 * window, a full quota). Every function here swallows that: a missing hint reads
 * as "no hint", and a failed write loses an optimisation, nothing more.
 *
 * THE STORAGE IS INJECTABLE so the unit tests need no browser.
 */
import { z } from 'zod';

/** The `localStorage` key. Named for what it is, so nobody mistakes it for a session. */
export const SIGNED_IN_HINT_KEY = 'kenning-signed-in-hint';

/** The three `Storage` methods this module uses. */
export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What the hint holds. */
export interface SignedInHint {
  userId: number;
}

/** What a stored value must look like to be believed. Anything else reads as no hint. */
const hintSchema = z.object({ userId: z.number().int().positive() });

/**
 * The browser's storage, or `null` where there is none or touching it throws.
 *
 * Reading `globalThis.localStorage` is itself the call that throws in a browser
 * that blocks storage, so the access sits inside the guard.
 */
function defaultStorage(): HintStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the hint.
 *
 * @param storage Where to read. Left out, the browser's `localStorage`.
 * @returns The hint, or `null` when there is none, it does not parse, or storage is unavailable.
 */
export function readSignedInHint(storage: HintStorage | null = defaultStorage()): SignedInHint | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(SIGNED_IN_HINT_KEY);
    if (raw === null) return null;
    const parsed = hintSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Remember who this browser is signed in as. A failed write is ignored.
 *
 * @param userId The account's integer id from the root data.
 * @param storage Where to write. Left out, the browser's `localStorage`.
 */
export function writeSignedInHint(userId: number, storage: HintStorage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.setItem(SIGNED_IN_HINT_KEY, JSON.stringify({ userId } satisfies SignedInHint));
  } catch {
    // A full or blocked store costs the offline shell its tabs, nothing else.
  }
}

/**
 * Forget the hint. A failed delete is ignored.
 *
 * @param storage Where to delete. Left out, the browser's `localStorage`.
 */
export function clearSignedInHint(storage: HintStorage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.removeItem(SIGNED_IN_HINT_KEY);
  } catch {
    // Nothing to do: the hint is display-only and the next write replaces it.
  }
}
