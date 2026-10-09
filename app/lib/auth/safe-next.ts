/**
 * The `next` path the offline page may send a reader back to.
 *
 * `/offline?next=` is written by the service worker, but a query string is
 * something anybody can type, so the offline page treats it as hostile input.
 * `sign-in.tsx` has its own private `safeNext` that falls back to `/`; this one
 * is stricter, because it also decides whether to leave the page automatically,
 * and it answers `null` rather than a fallback so the caller can tell "nothing
 * to go back to" from "go home".
 */

/** The origin the candidate is parsed against. Any value works, it is never used for navigation. */
const PARSE_ORIGIN = 'https://next.invalid';

/** Screens a reader is never sent back to: the account doors, and the offline page itself. */
const REFUSED_PATHS = new Set([
  '/sign-in',
  '/sign-up',
  '/sign-out',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
]);

const OFFLINE_PREFIX = '/offline';

/**
 * True for a backslash or a control character. Browsers strip or rewrite these
 * before they parse a URL, which can turn `/<tab>/evil.example` into
 * `//evil.example`.
 */
function hasUnsafeCharacter(raw: string): boolean {
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || character === '\\') return true;
  }
  return false;
}

/** A pathname with no trailing slash and no case, for comparing against the refused list. */
function comparable(pathname: string): string {
  const lower = pathname.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

/**
 * A same-origin absolute path that is safe to return to, or `null`.
 *
 * Accepts only a string that starts with a single `/`, holds no backslash and
 * no control character, stays on this origin once parsed, and does not name the
 * offline page or an account screen. The result is the parsed path, query and
 * fragment, so `/a/../b` comes back as `/b`.
 */
export function parseOfflineNext(raw: string | null): string | null {
  if (raw === null) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (hasUnsafeCharacter(raw)) return null;

  const parsed = new URL(raw, PARSE_ORIGIN);
  if (parsed.origin !== PARSE_ORIGIN) return null;

  const path = comparable(parsed.pathname);
  if (path === OFFLINE_PREFIX || path.startsWith(`${OFFLINE_PREFIX}/`)) return null;
  if (REFUSED_PATHS.has(path)) return null;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
