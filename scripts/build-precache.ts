/**
 * Post-build step: tell the service worker exactly which files make up this build.
 *
 * Run by `pnpm build`, after `react-router build`. It does two things to
 * `build/client`:
 *
 *   1. writes `precache.json`, the list of every hashed and static file the
 *      worker downloads on install, and
 *   2. writes the build stamp into `sw.js`, so the worker file changes whenever
 *      the file list changes and the browser installs the new one.
 *
 * WHY THE LIST IS COMPUTED HERE AND NOT WRITTEN BY HAND. The route chunks have
 * content hashes in their names, so the list changes on nearly every build. A
 * hand-kept list rots on the first deploy, and a worker that misses a chunk
 * paints the page and cannot hydrate it offline.
 *
 * The two pure functions are exported for the unit test. `main` only walks the
 * disk and writes, and it runs only when this file is the entry point, so
 * importing the module from a test does nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The one literal in `public/sw.js` that this script replaces. It appears there once, in quotes. */
const STAMP_PLACEHOLDER = "'__PRECACHE_STAMP__'";

/** Directories whose every file is precached. */
const PRECACHED_PREFIXES = ['/assets/', '/icons/', '/fonts/'];

/** Single files at the root that are precached. Nothing else at the root is. */
const PRECACHED_ROOT_FILES = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon.ico']);

/** Hex characters of the digest kept as the stamp. Twelve is plenty to tell two builds apart. */
const STAMP_LENGTH = 12;

/** What `precache.json` holds. `version` is for the worker to refuse a format it does not know. */
export interface PrecacheManifest {
  version: 1;
  stamp: string;
  assets: string[];
}

/** True when a URL path belongs in the precache. `sw.js`, `precache.json` and `.well-known` never do. */
function isPrecached(urlPath: string): boolean {
  if (PRECACHED_ROOT_FILES.has(urlPath)) return true;
  return PRECACHED_PREFIXES.some((prefix) => urlPath.startsWith(prefix) && urlPath.length > prefix.length);
}

/**
 * The manifest for a set of files, as URL paths with a leading slash.
 *
 * PURE. The list is filtered, de-duplicated and sorted, and the stamp is the
 * first 12 hex characters of a SHA-256 over the sorted list joined by newlines.
 * The same set of files in any order gives the same stamp, and any added,
 * removed or renamed file gives a different one. Hashed file names carry the
 * content, so a changed file always changes the list.
 */
export function buildPrecacheManifest(files: readonly string[]): PrecacheManifest {
  const assets = [...new Set(files.filter(isPrecached))].toSorted();
  const stamp = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, STAMP_LENGTH);
  return { version: 1, stamp, assets };
}

/**
 * The worker source with the stamp written in.
 *
 * PURE. Throws when the placeholder is absent or appears more than once. A
 * worker built without a stamp would name its shell cache from the literal
 * placeholder and never change between builds, which is the silent failure this
 * check exists to make loud.
 */
export function stampServiceWorker(source: string, stamp: string): string {
  const parts = source.split(STAMP_PLACEHOLDER);
  if (parts.length !== 2) {
    throw new Error(
      `sw.js must contain ${STAMP_PLACEHOLDER} exactly once, found ${parts.length - 1}. Did the worker lose its stamp constant?`,
    );
  }
  return parts.join(`'${stamp}'`);
}

/** Every file under a directory as a URL path such as `/assets/entry-abc.js`. */
function listClientFiles(clientDir: string): string[] {
  const relativePaths = readdirSync(clientDir, { recursive: true, encoding: 'utf8' });
  return relativePaths
    .filter((relativePath) => statSync(join(clientDir, relativePath)).isFile())
    .map((relativePath) => `/${relativePath.split(sep).join('/')}`);
}

function main(): void {
  const clientDir = resolve(import.meta.dirname, '..', 'build', 'client');
  if (!existsSync(clientDir)) {
    throw new Error(`${clientDir} does not exist. Run react-router build before this script.`);
  }

  const manifest = buildPrecacheManifest(listClientFiles(clientDir));
  if (manifest.assets.length === 0) {
    throw new Error(`No precacheable files under ${clientDir}. The build output is not what this script expects.`);
  }

  const workerPath = join(clientDir, 'sw.js');
  if (!existsSync(workerPath)) {
    throw new Error(`${workerPath} does not exist. Is public/sw.js missing from the build?`);
  }

  writeFileSync(join(clientDir, 'precache.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  writeFileSync(workerPath, stampServiceWorker(readFileSync(workerPath, 'utf8'), manifest.stamp), 'utf8');
  console.log(`[precache] stamp ${manifest.stamp}, ${manifest.assets.length} files`);
}

const entryPoint = process.argv.at(1);
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main();
}
