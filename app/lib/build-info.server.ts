/**
 * What build the SERVER is, resolved once at boot.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * `build-info.ts` reads a constant that Vite's `define` substitutes into the
 * bundles. `pnpm start` runs `tsx ./server.ts` (ADR-0004), which Vite never
 * touches, so in the entrypoint that constant is simply absent. `/api/build`
 * answers from HERE rather than from the SSR bundle's own copy, so the server's
 * answer has one source whatever is running it.
 *
 * ── THE SOURCE DEPENDS ON THE ENVIRONMENT, AND IT HAS TO ────────────────────
 *
 * THE FAILURE THIS PREVENTS: under `pnpm dev` the browser gets its stamp from
 * Vite, which computes it live when the dev server starts, while an earlier
 * `pnpm build` may have left a `build/build-info.json` from a different commit.
 * Read the file in dev and the two disagree permanently. `bundle-freshness.ts`
 * then sees two known, unequal shas on every poll and the ribbon offers a
 * reload for the rest of the session, on a page that is already the newest
 * there is. Reloading cannot clear it, because there is nothing to reload onto.
 * Every developer would meet it and it is invisible in production, where the
 * file is written by the build that produced the bundle.
 *
 * So:
 *
 * - **development** derives it LIVE, from the same two inputs
 *   `vite.config.ts` uses: `package.json`'s version and `git rev-parse --short
 *   HEAD`. The file is not read, not even as a fallback, because a stale
 *   answer is exactly the bug.
 * - **production** reads `build/build-info.json`, which the build wrote beside
 *   the bundle it describes, and falls back to the live derivation only when
 *   that file is missing. An image with no `build/` has no server bundle to
 *   run either, so that fallback is defensive rather than expected.
 *
 * `selectServerBuild` is the rule on its own, with both readers injected, so a
 * unit test can pin it with no filesystem.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { CONFIG } from '#app/config';
import { buildInfoSchema, UNKNOWN_SHA, type BuildInfo } from '#app/lib/build-info';

const manifestSchema = z.object({ version: z.string() });

/** Where the two readers come from. Injected so the rule below can be tested. */
export interface BuildInfoSources {
  /** The stamp `pnpm build` wrote, or null when there is no readable one. */
  stampFile: () => BuildInfo | null;
  /** The live answer, derived the way the Vite config derives it. */
  live: () => BuildInfo;
}

/**
 * Which source answers, given the environment. Development never touches the
 * stamp file: see this module's header for the false ribbon a stale read
 * produces.
 */
export function selectServerBuild({
  isProduction,
  sources,
}: {
  isProduction: boolean;
  sources: BuildInfoSources;
}): BuildInfo {
  if (!isProduction) return sources.live();
  return sources.stampFile() ?? sources.live();
}

/** Reads a file, or null if it is absent or unreadable. */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
  } catch {
    return null;
  }
}

function readStampFile(): BuildInfo | null {
  const contents = readFileOrNull('build/build-info.json');
  if (contents === null) return null;
  const parsed = buildInfoSchema.safeParse(JSON.parse(contents));
  return parsed.success ? parsed.data : null;
}

/**
 * The short commit of the working tree, or null when git cannot answer.
 *
 * Identical to `vite.config.ts`'s own `gitShortSha`, duplicated on purpose
 * rather than shared: that one runs in the build toolchain and this one runs in
 * the app, and an import across that line would pull the Vite config into the
 * server's module graph to read seven characters.
 */
function gitShortSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // No git binary, or not a repository. Both are ordinary inside an image.
    return null;
  }
}

/**
 * The live derivation: the manifest's version and the working tree's commit.
 *
 * `builtAt` is the moment this process started, which is the only honest answer
 * in dev, where nothing was built and the modules are compiled on demand.
 *
 * The `KENNING_BUILD_SHA` override is consulted FIRST, and must be, because
 * `vite.config.ts` consults it first too. A developer who sets it would
 * otherwise get a Vite-stamped bundle and a git-stamped server, which is the
 * same two-known-shas mismatch this file exists to prevent.
 */
function liveBuild(): BuildInfo {
  const contents = readFileOrNull('package.json');
  const manifest = contents === null ? null : manifestSchema.safeParse(JSON.parse(contents));
  const override = CONFIG.build.shaOverride.trim();
  return {
    version: manifest?.success === true ? manifest.data.version : '0.0.0-unstamped',
    sha: override === '' ? (gitShortSha() ?? UNKNOWN_SHA) : override.slice(0, 7),
    builtAt: new Date().toISOString(),
  };
}

/** This server's version, commit and build time. Resolved once, at import. */
export const SERVER_BUILD: BuildInfo = selectServerBuild({
  isProduction: CONFIG.app.isProduction,
  sources: { stampFile: readStampFile, live: liveBuild },
});
