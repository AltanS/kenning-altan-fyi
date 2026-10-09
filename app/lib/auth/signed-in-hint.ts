/**
 * signed-in-hint.ts, the one fact the app keeps so the shell can DRAW itself
 * offline, and the one fact that decides whether this device may sync:
 * "this browser holds the data of user N", and whether sync is paused.
 *
 * IT IS DISPLAY-ONLY, AND IT MAY ONLY WITHHOLD. It is never a credential, it
 * authorises nothing, and no decision that costs money or reveals data may read
 * it. The session cookie is httpOnly, so script cannot see whether it is still
 * valid, and offline there is no server to ask. Without a hint the root
 * `clientLoader` has to answer "nobody is signed in" when the network is gone,
 * and the sidebar, the bottom tabs and the favourite star all disappear from a
 * reader who is, in fact, still signed in and reading their own device. The
 * hint lets those controls stay where the reader left them. A wrong hint costs a
 * few navigation links that lead to a "this screen needs a connection" card, and
 * the server still refuses everything that needed an account the moment a
 * request reaches it.
 *
 * The only other thing the hint may do is HOLD SYNC BACK. A paused hint stops
 * this device from starting a sync request. It can never start one: a sync
 * session is still installed only from a root answer that named a user, and the
 * server still checks the cookie on every request.
 *
 * WHAT IT HOLDS: `{ userId, pause? }` and nothing else. `userId` is the account
 * whose data THIS DEVICE'S STORE holds, which is not always the account that is
 * signed in right now. `pause` says sync is withheld, why, and since when.
 * The address, the name and every flag stay on the server.
 *
 *   `expired`        the server ended the session (a 401). The data on the device
 *                    is still this account's. Signing in as the same account
 *                    resumes sync.
 *   `other-account`  somebody else signed in on a device that holds this
 *                    account's data. Nothing syncs until the data is erased or
 *                    the original account signs back in.
 *
 * Old values, `{ userId }` alone, still parse: a hint with no pause is a hint
 * with sync allowed.
 *
 * WHO WRITES IT
 *   - `confirmSignedInHint`, from the `_app.tsx` confirm effect, when a live
 *     root answer names a user: adopts the first account, clears a pause for the
 *     same account, or pauses for a different one.
 *   - `setSyncPause`, from `pauseSyncOnAuthFailure` (a 401 or a 412 on a sync
 *     request, through the scheduler and `sync-client.ts`) and from
 *     `sign-out.tsx` when the stored data is not the signing-out account's.
 *   - `replaceSignedInHint`, from the erase flow in `sync-paused-ribbon.tsx`,
 *     once the old account's databases are gone.
 * WHO CLEARS IT
 *   - `clearSignedInHint`, from `sign-out.tsx`'s normal branch ONLY. A deliberate
 *     sign-out is the one moment a person says they are done with this browser,
 *     and the wipe that goes with it is why the hint goes too. An expired
 *     session, a 401, a 412 and a redirect never clear it.
 *
 * SSR-SAFE AND NEVER THROWING. `localStorage` does not exist during a server
 * render, and in a browser it can throw on access (blocked storage, a private
 * window, a full quota). Every function here swallows that: a missing hint reads
 * as "no hint", and a failed write loses an optimisation, nothing more.
 *
 * EVERY WRITE TELLS THIS TAB. The browser's `storage` event fires in the OTHER
 * tabs only, so {@link subscribeSignedInHint} also keeps a module emitter that
 * each successful write and clear calls. A component that reads the hint through
 * `useSyncExternalStore` (`use-signed-in-hint.ts`) sees a pause the moment the
 * scheduler writes it.
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

/** Why sync is withheld. See the header for what each one means. */
export type SyncPauseReason = 'expired' | 'other-account';

/** A pause: the reason, and when it began (epoch milliseconds). */
export interface SyncPause {
  reason: SyncPauseReason;
  at: number;
}

/** What the hint holds. */
export interface SignedInHint {
  /** The account whose data this device's store holds. */
  userId: number;
  /** Present while sync is withheld. */
  pause?: SyncPause;
}

/** What `confirmSignedInHint` did. */
export type ConfirmOutcome = 'adopted' | 'confirmed' | 'other-account';

/**
 * What a stored value must look like to be believed. Anything else reads as no
 * hint, including a pause with a reason this build does not know: a hint that
 * cannot be understood must not be read as permission to sync.
 */
const hintSchema = z.object({
  userId: z.number().int().positive(),
  pause: z.object({ reason: z.enum(['expired', 'other-account']), at: z.number() }).optional(),
});

/** Called after every successful write or clear in this tab. */
const listeners = new Set<() => void>();

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

/** Tells every subscriber in this tab that the stored hint may have changed. */
function notifyListeners(): void {
  for (const listener of listeners) listener();
}

/**
 * The stored text exactly as it sits in storage, or `null`.
 *
 * THIS IS THE SNAPSHOT `useSignedInHint` hands to `useSyncExternalStore`. A
 * string is a stable value, so React compares it with `Object.is` and does not
 * re-render when nothing changed; a freshly parsed object would be new on every
 * call and loop forever.
 *
 * @param storage Where to read. Left out, the browser's `localStorage`.
 * @returns The raw text, or `null` when there is none or storage is unavailable.
 */
export function readRawSignedInHint(storage: HintStorage | null = defaultStorage()): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(SIGNED_IN_HINT_KEY);
  } catch {
    return null;
  }
}

/**
 * Parse stored text into a hint.
 *
 * @param raw What {@link readRawSignedInHint} returned.
 * @returns The hint, or `null` when there is none or the text is not a valid hint.
 */
export function parseSignedInHint(raw: string | null): SignedInHint | null {
  if (raw === null) return null;
  try {
    const parsed = hintSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
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
  return parseSignedInHint(readRawSignedInHint(storage));
}

/**
 * Store a hint and tell this tab. A write that changes nothing is skipped, and a
 * failed write is ignored.
 */
function writeHint({ hint, storage }: { hint: SignedInHint; storage: HintStorage | null }): void {
  if (storage === null) return;
  try {
    const next = JSON.stringify(hint);
    if (storage.getItem(SIGNED_IN_HINT_KEY) === next) return;
    storage.setItem(SIGNED_IN_HINT_KEY, next);
  } catch {
    // A full or blocked store costs the offline shell its tabs, nothing else.
    return;
  }
  notifyListeners();
}

/**
 * Say which account a live server answer named, and what that means for the
 * data on this device.
 *
 * Only a LIVE root answer may call this. The offline fallback answer is built
 * from the hint itself, and confirming a hint with itself proves nothing.
 *
 * - No hint yet: this device adopts the account (`adopted`).
 * - The same account: any pause is removed (`confirmed`). This is how signing in
 *   again resumes sync.
 * - A different account: the hint keeps naming the account whose data is here
 *   and gains an `other-account` pause (`other-account`). An existing pause
 *   keeps its `at`, so the time shown is when the problem began.
 *
 * @param userId The id the live root data named.
 * @param storage Where to read and write. Left out, the browser's `localStorage`.
 */
export function confirmSignedInHint(userId: number, storage: HintStorage | null = defaultStorage()): ConfirmOutcome {
  const hint = readSignedInHint(storage);
  if (hint === null) {
    writeHint({ hint: { userId }, storage });
    return 'adopted';
  }
  if (hint.userId === userId) {
    if (hint.pause !== undefined) writeHint({ hint: { userId }, storage });
    return 'confirmed';
  }
  writeHint({
    hint: { userId: hint.userId, pause: { reason: 'other-account', at: hint.pause?.at ?? Date.now() } },
    storage,
  });
  return 'other-account';
}

/**
 * Withhold sync, and say why.
 *
 * It OVERWRITES the reason. It changes nothing when there is no hint: a pause
 * needs an account whose data it protects, and inventing one here would let a
 * 401 on a signed-out page create a hint out of nothing. An existing pause keeps
 * its `at`.
 *
 * @param reason Why sync is withheld.
 * @param storage Where to read and write. Left out, the browser's `localStorage`.
 */
export function setSyncPause(reason: SyncPauseReason, storage: HintStorage | null = defaultStorage()): void {
  const hint = readSignedInHint(storage);
  if (hint === null) return;
  writeHint({ hint: { userId: hint.userId, pause: { reason, at: hint.pause?.at ?? Date.now() } }, storage });
}

/**
 * Replace the hint with a fresh one for another account, with no pause.
 *
 * ONLY THE ERASE FLOW CALLS THIS, after the old account's databases are gone:
 * the device then holds nothing, and the account signed in now is the one whose
 * data it will pull.
 *
 * @param userId The account the device will hold data for from now on.
 * @param storage Where to write. Left out, the browser's `localStorage`.
 */
export function replaceSignedInHint(userId: number, storage: HintStorage | null = defaultStorage()): void {
  writeHint({ hint: { userId }, storage });
}

/**
 * Forget the hint. A failed delete is ignored.
 *
 * ONLY `sign-out.tsx`'s normal branch calls this. See the header.
 *
 * @param storage Where to delete. Left out, the browser's `localStorage`.
 */
export function clearSignedInHint(storage: HintStorage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.removeItem(SIGNED_IN_HINT_KEY);
  } catch {
    // Nothing to do: the hint is display-only and the next write replaces it.
    return;
  }
  notifyListeners();
}

/**
 * Call back when the stored hint may have changed.
 *
 * Two sources feed it: this module's own writes and clears, which the browser's
 * `storage` event never reports to the tab that made them, and the `storage`
 * event itself, which reports a change made in another tab. A `null` key is the
 * event for `localStorage.clear()`.
 *
 * @param onChange Called with no arguments. Read the hint again inside it.
 * @returns A function that stops the callbacks.
 */
export function subscribeSignedInHint(onChange: () => void): () => void {
  listeners.add(onChange);
  if (globalThis.window === undefined) {
    return () => {
      listeners.delete(onChange);
    };
  }

  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === SIGNED_IN_HINT_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}
