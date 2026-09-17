/**
 * What build this page is. One module, read by the browser and by the SSR
 * render alike.
 *
 * `BUILD` is the object Vite's `define` substitutes at build time: see
 * `vite.config.ts` for how it is computed and `types/build-info.d.ts` for why
 * it is a bare identifier rather than a property lookup.
 *
 * NOT `.server.ts`, deliberately: the stamp is shown in the avatar menu and
 * compared against the server's answer by `app/lib/update-store.ts`, both of
 * which are client surfaces. Code running outside Vite has its own reader,
 * `build-info.server.ts`.
 */
import { z } from 'zod';

/** Version, commit and timestamp of the bundle this page is running. */
export type BuildInfo = KenningBuildInfo;

/**
 * The stamp as it crosses a boundary: the `build/build-info.json` file and the
 * `/api/build` response body are the same three fields, so they are parsed
 * with one schema rather than with two that can drift.
 */
export const buildInfoSchema = z.object({
  version: z.string(),
  sha: z.string(),
  builtAt: z.string(),
});

/** The sha a build stamps when it could not learn its own commit. */
export const UNKNOWN_SHA = 'unknown';

/**
 * What a module reads when nothing defined the constant.
 *
 * That is exactly one situation: a unit test importing this module outside a
 * Vite build, where `__KENNING_BUILD__` was never substituted. Every build the
 * app ships in defines it. The version is deliberately NOT `package.json`'s: a
 * plausible-looking version here would be worse than an obviously fake one,
 * because it would let a broken `define` reach production wearing the right
 * number.
 */
const UNSTAMPED: BuildInfo = {
  version: '0.0.0-unstamped',
  sha: UNKNOWN_SHA,
  builtAt: '1970-01-01T00:00:00.000Z',
};

/**
 * The injected stamp, or null outside a Vite build.
 *
 * A `try` rather than a presence check: an identifier that was never declared
 * throws `ReferenceError` on read, and that throw is the only signal
 * available. Testing `globalThis.__KENNING_BUILD__` instead would report null
 * in the browser too, because esbuild substitutes the identifier and not the
 * property access.
 */
function injectedBuild(): BuildInfo | null {
  try {
    return __KENNING_BUILD__;
  } catch {
    return null;
  }
}

/** This bundle's version, commit and build time. */
export const BUILD: BuildInfo = injectedBuild() ?? UNSTAMPED;

/**
 * The one-line stamp shown at the foot of the avatar menu: `v0.1.0 . 586caeb`,
 * with a middle dot between the halves.
 *
 * The separator is a middle dot and never a dash of any width (DESIGN.md rule
 * 2). A build with no sha, a local `pnpm build` on a machine with no git,
 * drops the second half rather than printing the word "unknown" at a person.
 */
export function formatBuildLabel(build: BuildInfo): string {
  const version = `v${build.version}`;
  if (build.sha === UNKNOWN_SHA || build.sha === '') return version;
  return `${version} · ${build.sha}`;
}
