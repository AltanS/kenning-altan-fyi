import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { z } from 'zod';

/**
 * ── THE BUILD STAMP ───────────────────────────────────────────────────────
 *
 * One object, computed once here, delivered two ways:
 *
 *  1. `define` replaces `__KENNING_BUILD__` in the browser and SSR bundles, so
 *     `app/lib/build-info.ts` reads a literal with no runtime lookup. See
 *     `types/build-info.d.ts` for why it is a bare identifier.
 *  2. `build/build-info.json`, written once when a bundle closes, so code
 *     running OUTSIDE Vite can read the same numbers. `pnpm start` runs
 *     `tsx ./server.ts` (ADR-0004), which Vite never touches, so no `define`
 *     ever reaches the entrypoint. A file on disk beside the bundle it
 *     describes is the smallest thing that works for `pnpm build` then
 *     `pnpm start`, and it needs no git inside the image.
 *
 * "The same object" is load-bearing. `react-router build` runs a client pass
 * and an SSR pass and re-evaluates this file for each, in one process, so
 * computing the stamp per evaluation would give the two bundles two different
 * `builtAt` values and the JSON a third. The first pass parks its answer on
 * `globalThis` and the second reuses it. The same object carries the
 * write-once flag, because `closeBundle` also fires per pass.
 *
 * The sha is the one value that is not free, and where it comes from is worth
 * knowing. `KENNING_BUILD_SHA` wins when it is set. Otherwise `git rev-parse`
 * answers, and it answers INSIDE THE IMAGE TOO: `.dockerignore` does not
 * exclude `.git`, Bay builds from a persistent checkout on the infra server,
 * and `Dockerfile.pnpm` installs git in the build stage for exactly this. A
 * build with neither says `unknown` rather than guessing, because an unstamped
 * build has to be obviously unstamped and never plausibly wrong. `unknown` is
 * also never counted as a mismatch (see `app/lib/bundle-freshness.ts`), so a
 * build that loses its stamp goes quiet instead of nagging.
 */

/** The build-time stamp, parked across the two passes of one `pnpm build`. */
interface KenningBuildStamp {
  build: KenningBuildInfo;
  hasWrittenFile: boolean;
}

declare global {
  // Build-time only. Nothing under `app/` may read this, and nothing does.
  var __kenningBuildStamp: KenningBuildStamp | undefined;
}

/** The one field of `package.json` this file needs. */
const manifestSchema = z.object({ version: z.string() });

/** `package.json`'s `version`, parsed rather than asserted. */
function packageVersion(): string {
  const manifest = manifestSchema.safeParse(
    JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')),
  );
  return manifest.success ? manifest.data.version : '0.0.0';
}

/** The short commit sha of the working tree, or null when git cannot answer. */
function gitShortSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // No git binary, or not a repository. Both are ordinary inside an image.
    return null;
  }
}

/** The one stamp this build uses, computed on the first pass and reused by the second. */
function buildStamp(shaOverride: string | undefined): KenningBuildStamp {
  const existing = globalThis.__kenningBuildStamp;
  if (existing !== undefined) return existing;

  const override = shaOverride?.trim() ?? '';
  const stamp: KenningBuildStamp = {
    build: {
      version: packageVersion(),
      sha: override === '' ? (gitShortSha() ?? 'unknown') : override.slice(0, 7),
      builtAt: new Date().toISOString(),
    },
    hasWrittenFile: false,
  };
  globalThis.__kenningBuildStamp = stamp;
  return stamp;
}

/** Writes the stamp beside the bundle, once per build, for the Express entrypoint to read. */
function buildInfoFilePlugin(stamp: KenningBuildStamp): Plugin {
  return {
    name: 'kenning-build-info-file',
    // `closeBundle` fires for the client pass and again for the SSR pass. Both
    // would write identical bytes now that the stamp is shared, but writing
    // once says so: a second write would be the only place left that could
    // disagree with the first.
    closeBundle() {
      if (stamp.hasWrittenFile) return;
      stamp.hasWrittenFile = true;
      const directory = resolve(import.meta.dirname, 'build');
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, 'build-info.json'), `${JSON.stringify(stamp.build, null, 2)}\n`, 'utf8');
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const hmrPort = env.HMR_PORT ? parseInt(env.HMR_PORT, 10) : 24678;
  const serverPort = env.PORT ? parseInt(env.PORT, 10) : 3000;
  // Lets the dev server be opened over the tailnet by machine name (e.g. "bluefin"),
  // which Vite otherwise refuses as an unrecognized Host header.
  const allowedHosts = env.DEV_ALLOWED_HOSTS
    ? env.DEV_ALLOWED_HOSTS.split(',')
        .map((host) => host.trim())
        .filter((host) => host.length > 0)
    : undefined;

  // `loadEnv` with an empty prefix already merges `process.env`, so a build
  // argument arrives here without a second env read.
  const stamp = buildStamp(env.KENNING_BUILD_SHA);

  return {
    plugins: [tailwindcss(), reactRouter(), buildInfoFilePlugin(stamp)],
    define: {
      __KENNING_BUILD__: JSON.stringify(stamp.build),
    },
    resolve: {
      tsconfigPaths: true,
    },
    server: {
      port: serverPort,
      hmr: { port: hmrPort },
      allowedHosts,
    },
  };
});
