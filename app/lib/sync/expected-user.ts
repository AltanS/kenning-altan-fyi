/**
 * expected-user.ts, the header that stops one account's data reaching another.
 *
 * A device's local store belongs to ONE account, and the cookie names whoever is
 * signed in now. When they differ, a push would merge the first account's lists
 * into the second account's document. The client therefore says which account
 * its data is for, on every sync request, and the server refuses a request whose
 * cookie names somebody else.
 *
 * THE HEADER IS A CLAIM, NOT A CREDENTIAL. The server still authorises from the
 * cookie alone; this only lets it refuse a mismatch before it reads or writes
 * anything. A caller that sends no header is not checked, so a tab running an
 * older build keeps working.
 *
 * Client-safe: no server imports, so the browser bundle and the route share it.
 */

/** The request header carrying the account the sender's data belongs to. */
export const EXPECTED_USER_HEADER = 'X-Kenning-Expected-User';

/** What {@link readExpectedUser} found. One literal per member, so each narrows on its own. */
export type ExpectedUser =
  /** No header: the caller did not say, and no check is made. */
  | { kind: 'absent' }
  /** A header that is not a positive integer. A bug on the sender's side. */
  | { kind: 'invalid' }
  /** The account the sender says its data belongs to. */
  | { kind: 'user'; userId: number };

/** A positive integer in plain digits: no sign, no space, no leading zero. */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * Read the expected account out of a request's headers.
 *
 * @param headers The request headers.
 * @returns `absent`, `invalid`, or the claimed account.
 */
export function readExpectedUser(headers: Headers): ExpectedUser {
  const raw = headers.get(EXPECTED_USER_HEADER);
  if (raw === null) return { kind: 'absent' };
  if (!POSITIVE_INTEGER.test(raw)) return { kind: 'invalid' };
  const userId = Number(raw);
  if (!Number.isSafeInteger(userId)) return { kind: 'invalid' };
  return { kind: 'user', userId };
}
