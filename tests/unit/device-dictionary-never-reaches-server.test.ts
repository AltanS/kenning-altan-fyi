/**
 * Guard: no byte of the device dictionary may reach the server (ADR-0013, M208).
 *
 * THE RULE, IN ONE LINE. The reader loads a WikDict file into their own device.
 * That data is CC BY-SA, which `SERVED_LICENCES` deliberately excludes, so the
 * only thing that keeps the product clear of a share-alike duty is that the
 * server never fetches, stores, proxies or serves any of it. This file is the
 * single named tripwire for that rule. `local-dictionary-store.test.ts` and
 * `device-dictionary-hit-stays-local.test.ts` hold narrower checks on the same
 * ground, and a short overlap with them is fine: this is the one a reviewer is
 * pointed at.
 *
 * EVERY FAILURE NAMES THE RULE. If one of these fails, fix the code that
 * crossed the line. Do not loosen the test to make the build green.
 *
 * NINE CHECKS.
 *   1. No server-side file imports anything under `app/lib/local-dictionary/`.
 *   2. Nothing under `app/lib/local-dictionary/` imports a server module, the
 *      database, TinyBase or the local store (TinyBase syncs to the server).
 *   3. Outside that directory, only an explicit list of files may import it.
 *   4. The history recorder, the favourite star and the local store never name
 *      the device dictionary, so a hit cannot be handed to them.
 *   5. No route reads the `device-dict` cookie itself. Routes ask the gate
 *      module, which answers yes or no for one direction.
 *   6. `package.json` gains no SQLite or IndexedDB-wrapper package.
 *   7. The directory opens no network connection and writes no cookie.
 *   8. `SERVED_LICENCES` is still exactly the three licences.
 *   9. Offline search hands the route ROUTING FACTS only: the plan and the
 *      loader data name no entry, no translation and no written form, and the
 *      route itself never touches the lookup.
 *
 * IT READS SOURCE TEXT, NOT BEHAVIOUR. Imports are read after comments are
 * stripped, so a comment that names a path (this file's own header does) cannot
 * trip a check. A specifier is resolved to a repo path before it is compared, so
 * a relative import and a `#app/` alias are the same import.
 *
 * IT PROVES ITSELF FIRST. Every scanned set must hold files, or a path typo
 * would let an empty list pass every loop below. The detectors also run over
 * synthetic source that must trip them and source that must not.
 *
 * NO DATABASE. This reads files.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { SERVED_LICENCES } from '#app/lib/dictionary/licences';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Appended to every failure message, so the next person fixes the code and not the test. */
const RULE = 'the device dictionary must never reach the server (ADR-0013); fix the code, not this test';

const ENGINE_DIRECTORY = 'app/lib/local-dictionary';

/**
 * The files outside the engine directory that may import it.
 *
 * Derived from the repo on 2026-10-07: the settings card, the hit card, and the
 * search screen that hosts the hook. `translation-pane.tsx` and
 * `device-dictionary-gate.ts` do not import the engine, and must not: the gate
 * reads the cookie, never the store.
 *
 * `app/lib/offline/plan-on-device.ts` joined on 2026-10-09 with offline search.
 * It is the one door the search route's client loader uses to PICK A DIRECTION
 * from the dictionaries on the device, and it returns routing facts only (see
 * the next test file in this directory, which pins that). The route itself is
 * deliberately not on this list.
 */
const ENGINE_IMPORTERS = new Set([
  'app/components/personal/device-dictionary-card.tsx',
  'app/components/device-dictionary-hit.tsx',
  'app/components/search-panes.tsx',
  'app/lib/offline/plan-on-device.ts',
]);

/** The two components that carry what a reader searched for, and so must never be handed a hit. */
const HIT_FREE_COMPONENTS = [
  'app/components/personal/record-search.tsx',
  'app/components/personal/favorite-toggle.tsx',
] as const;

/** Package names that would put a SQL engine or an IndexedDB wrapper in the dependency list. */
const FORBIDDEN_PACKAGE = /sqlite|sql\.js|better-sqlite|wa-sqlite|idb(-keyval)?$|dexie|fake-indexeddb/;

/** Module specifiers the engine directory may not import, beyond the `.server` suffix. */
const FORBIDDEN_ENGINE_PREFIXES = ['#drizzle', 'drizzle-orm', 'tinybase'] as const;

/** The local store syncs to the server in a blob, so the engine may not touch it. */
const LOCAL_STORE_DIRECTORY = 'app/lib/local-store';

/** What opens a connection or writes a cookie. The cookie writer lives outside the engine directory. */
const OUTBOUND_TOKENS = ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'document.cookie'] as const;
const FETCH_CALL = /\bfetch\s*\(/;

function read(file: string): string {
  return readFileSync(`${REPO_ROOT}${file}`, 'utf8');
}

/** Every `.ts` and `.tsx` file under one repo directory, as repo-relative paths. */
function sourceFilesUnder(directory: string): string[] {
  return readdirSync(`${REPO_ROOT}${directory}`, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => posix.join(directory, entry))
    .toSorted();
}

/**
 * The source with its comments removed.
 *
 * A HEURISTIC, NOT A PARSER, in the same shape as the explanation-listing guard.
 * A line holding a quote before its `//` is left whole, so a token named in a
 * real comment on such a line is OVER-reported, which is the safe direction.
 * A `//` inside a regex literal truncates its line, which is the unsafe one.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const comment = line.indexOf('//');
      if (comment === -1) return line;
      const before = line.slice(0, comment);
      return /['"`]/.test(before) ? line : before;
    })
    .join('\n');
}

/** Every module specifier a file names: `from '…'`, `import('…')`, `import '…'` and `require('…')`. */
function specifiersOf(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g;
  return [...stripComments(source).matchAll(pattern)].map((match) => match[2] ?? '');
}

interface ResolveOptions {
  /** The repo-relative path of the importing file. */
  importer: string;
  specifier: string;
}

/**
 * A specifier as a repo-relative path, or the bare specifier when it is a package.
 *
 * `#app/x` is `app/x`, `#drizzle/x` is `drizzle/x`, and `./x` or `../x` is joined
 * onto the importer's directory. Anything else is a package name and stays as it is.
 */
function resolveSpecifier({ importer, specifier }: ResolveOptions): string {
  if (specifier.startsWith('#app/')) return `app/${specifier.slice('#app/'.length)}`;
  if (specifier.startsWith('#drizzle/')) return `drizzle/${specifier.slice('#drizzle/'.length)}`;
  if (specifier.startsWith('.')) return posix.normalize(posix.join(posix.dirname(importer), specifier));
  return specifier;
}

interface InsideOptions {
  path: string;
  directory: string;
}

/** Whether a resolved path is the directory itself or anything below it. */
function isInside({ path, directory }: InsideOptions): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** The specifiers in `source` that resolve into `directory`. */
function importsInto(source: string, importer: string, directory: string): string[] {
  return specifiersOf(source).filter((specifier) =>
    isInside({ path: resolveSpecifier({ importer, specifier }), directory }),
  );
}

/** The specifiers the engine directory may not import: a `.server` module, the database, TinyBase, the local store. */
function forbiddenEngineImports(source: string, importer: string): string[] {
  return specifiersOf(source).filter((specifier) => {
    if (/\.server(\.[cm]?[jt]sx?)?$/.test(specifier)) return true;
    const resolved = resolveSpecifier({ importer, specifier });
    if (isInside({ path: resolved, directory: LOCAL_STORE_DIRECTORY })) return true;
    return FORBIDDEN_ENGINE_PREFIXES.some((prefix) => isInside({ path: specifier, directory: prefix }));
  });
}

/** The outbound or cookie-writing tokens a source uses in code. */
function outboundCalls(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = OUTBOUND_TOKENS.filter((token) => code.includes(token));
  if (FETCH_CALL.test(code)) hits.push('fetch(');
  return hits;
}

/** Whether the code, comments aside, names either spelling of the device dictionary. */
function namesDeviceDictionary(source: string): boolean {
  const code = stripComments(source);
  return code.includes('local-dictionary') || code.includes('device-dictionary');
}

const SERVER_FILE_NAME = /\.server\.tsx?$/;
const API_ROUTE_NAME = /^app\/routes\/(?:.*\/)?api\.[^/]*$/;

/** Every file the rule forbids from importing the engine, found by walking and not by a hand-kept list. */
function serverSideFiles(): string[] {
  const appFiles = sourceFilesUnder('app');
  const byName = appFiles.filter((file) => SERVER_FILE_NAME.test(file) || API_ROUTE_NAME.test(file));
  const byDirectory = ['app/models', 'app/workflows', 'app/services', 'cli', 'drizzle'].flatMap((directory) =>
    sourceFilesUnder(directory),
  );
  return [...new Set([...byName, ...byDirectory, 'server.ts'])].toSorted();
}

// ── Synthetic source, so every detector can be shown to work ──────────────

const ALIAS_IMPORT = `import { lookupDeviceEntry } from '#app/lib/local-dictionary/device-dictionary-store';`;
const RELATIVE_IMPORT = `import { lookupDeviceEntry } from '../lib/local-dictionary/device-dictionary-store';`;
const DYNAMIC_IMPORT = `const store = await import('#app/lib/local-dictionary/wikdict');`;
const RE_EXPORT = `export * from '#app/lib/local-dictionary/card-state';`;
const SIDE_EFFECT_IMPORT = `import '#app/lib/local-dictionary/wikdict';`;
const MULTILINE_IMPORT = `import {\n  lookupDeviceEntry,\n  importDictionary,\n} from '#app/lib/local-dictionary/device-dictionary-store';`;

/** A comment that names a path, which the header of this very file does. */
const COMMENT_ONLY = `
// Never import #app/lib/local-dictionary/wikdict from a model.
/* import { x } from '#app/lib/local-dictionary/wikdict'; */
import { z } from 'zod';
`;

describe('the detectors', () => {
  it('reads every import form as an import into the engine, relative or aliased', () => {
    const importer = 'app/models/thing.server.ts';
    for (const source of [ALIAS_IMPORT, RELATIVE_IMPORT, DYNAMIC_IMPORT, RE_EXPORT, SIDE_EFFECT_IMPORT, MULTILINE_IMPORT]) {
      assert.equal(
        importsInto(source, importer, ENGINE_DIRECTORY).length,
        1,
        `an import form walked past the detector: ${source}\n${RULE}`,
      );
    }
  });

  it('does not read a comment that names a path as an import', () => {
    assert.deepEqual(importsInto(COMMENT_ONLY, 'app/models/thing.server.ts', ENGINE_DIRECTORY), []);
    assert.equal(namesDeviceDictionary(COMMENT_ONLY), false);
  });

  it('flags a server module, the database, TinyBase and the local store inside the engine', () => {
    const importer = `${ENGINE_DIRECTORY}/wikdict.ts`;
    const bad = [
      `import { db } from '#app/models/thing.server';`,
      `import { db } from '#drizzle/db';`,
      `import { eq } from 'drizzle-orm/pg-core';`,
      `import { createStore } from 'tinybase';`,
      `import { getStore } from '#app/lib/local-store/store';`,
      `import { getStore } from '../local-store/favorites';`,
    ];
    for (const source of bad) {
      assert.equal(forbiddenEngineImports(source, importer).length, 1, `${source} was not flagged\n${RULE}`);
    }
    const good = `import { z } from 'zod';\nimport { normalizeQuery } from '#app/lib/dictionary/normalize';\nimport { readTableRows } from './sqlite-table-reader';`;
    assert.deepEqual(forbiddenEngineImports(good, importer), []);
  });

  it('flags a network call and a cookie write, and passes a comment that names them', () => {
    assert.deepEqual(outboundCalls(`await fetch('/api/x');`), ['fetch(']);
    assert.deepEqual(outboundCalls(`navigator.sendBeacon('/x', body);`), ['sendBeacon']);
    assert.deepEqual(outboundCalls(`document.cookie = 'a=b';`), ['document.cookie']);
    assert.deepEqual(outboundCalls(`const socket = new WebSocket(url);`), ['WebSocket']);
    assert.deepEqual(outboundCalls(`const request = new XMLHttpRequest();`), ['XMLHttpRequest']);
    assert.deepEqual(outboundCalls(`// never call fetch( or sendBeacon here\nconst prefetched = 1;`), []);
  });

  it('flags either spelling of the device dictionary in code', () => {
    assert.equal(namesDeviceDictionary(`import x from '#app/lib/local-dictionary/wikdict';`), true);
    assert.equal(namesDeviceDictionary(`const key = 'device-dictionary';`), true);
    assert.equal(namesDeviceDictionary(`import { x } from './favorites';`), false);
  });
});

describe('the device dictionary never reaches the server', () => {
  const engineFiles = sourceFilesUnder(ENGINE_DIRECTORY);
  const serverFiles = serverSideFiles();
  const appFiles = sourceFilesUnder('app');
  const routeFiles = sourceFilesUnder('app/routes');
  const localStoreFiles = sourceFilesUnder(LOCAL_STORE_DIRECTORY);

  it('found every set of files it claims to scan', () => {
    assert.ok(
      engineFiles.length > 0,
      `walked no files under ${ENGINE_DIRECTORY}, so checks 2 and 7 would pass over nothing.\n${RULE}`,
    );
    assert.ok(
      serverFiles.length > 20,
      `walked ${serverFiles.length} server-side files, expected well over 20. Check 1 would pass over a near-empty list.\n${RULE}`,
    );
    assert.ok(
      serverFiles.some((file) => file.startsWith('app/models/')) &&
        serverFiles.some((file) => file.startsWith('app/workflows/')) &&
        serverFiles.some((file) => file.startsWith('cli/')) &&
        serverFiles.some((file) => API_ROUTE_NAME.test(file)) &&
        serverFiles.some((file) => SERVER_FILE_NAME.test(file)),
      `the server-side walk is missing one of models, workflows, cli, api routes or .server files.\n${RULE}`,
    );
    assert.ok(appFiles.length > 100, `walked ${appFiles.length} files under app, expected well over 100.\n${RULE}`);
    assert.ok(routeFiles.length > 0, `walked no files under app/routes, so check 5 would pass over nothing.\n${RULE}`);
    assert.ok(
      localStoreFiles.length > 0,
      `walked no files under ${LOCAL_STORE_DIRECTORY}, so check 4 would pass over nothing.\n${RULE}`,
    );
    for (const file of [...HIT_FREE_COMPONENTS, ...ENGINE_IMPORTERS]) {
      assert.ok(existsSync(`${REPO_ROOT}${file}`), `${file} does not exist. A rename must be noticed here.\n${RULE}`);
    }
  });

  it('parses the imports it relies on', () => {
    const engineImports = engineFiles.flatMap((file) => specifiersOf(read(file)));
    assert.ok(
      engineImports.length >= 5,
      `parsed ${engineImports.length} import specifiers out of ${ENGINE_DIRECTORY}. Zero means the parser stopped ` +
        `matching, not that the directory is clean.\n${RULE}`,
    );
  });

  // Check 1.
  it('is imported by no server-side module', () => {
    const offenders = serverFiles.flatMap((file) =>
      importsInto(read(file), file, ENGINE_DIRECTORY).map((specifier) => `${file} imports ${specifier}`),
    );
    assert.deepEqual(
      offenders,
      [],
      `a server-side file imports the device dictionary:\n${offenders.join('\n')}\n${RULE}`,
    );
  });

  // Check 2.
  for (const file of engineFiles) {
    it(`${file} imports no server module, database, TinyBase or local store`, () => {
      const offenders = forbiddenEngineImports(read(file), file);
      assert.deepEqual(
        offenders,
        [],
        `${file} imports ${offenders.join(', ')}. TinyBase syncs to the server and the others reach it directly.\n${RULE}`,
      );
    });
  }

  // Check 3.
  it('is imported, outside its directory, only by the files on the allow-list', () => {
    const importers = appFiles
      .filter((file) => !isInside({ path: file, directory: ENGINE_DIRECTORY }))
      .filter((file) => importsInto(read(file), file, ENGINE_DIRECTORY).length > 0);
    assert.ok(importers.length > 0, `found no importer of the engine at all, so the allow-list check proves nothing.\n${RULE}`);

    const unlisted = importers.filter((file) => !ENGINE_IMPORTERS.has(file));
    assert.deepEqual(
      unlisted,
      [],
      `${unlisted.join(', ')} imports the device dictionary and is not on the allow-list.\n` +
        'Add a file to ENGINE_IMPORTERS ONLY after checking that it does not forward a hit to a request: not to a ' +
        `fetcher, a form, a loader argument, a prompt or the search history.\n${RULE}`,
    );
  });

  // Check 4.
  for (const file of HIT_FREE_COMPONENTS) {
    it(`${file} does not name the device dictionary`, () => {
      assert.equal(
        namesDeviceDictionary(read(file)),
        false,
        `${file} names the device dictionary. This component carries a search to the server or the sync blob, so a ` +
          `hit must never be handed to it.\n${RULE}`,
      );
    });
  }

  it('is named by no file under app/lib/local-store', () => {
    const offenders = localStoreFiles.filter((file) => namesDeviceDictionary(read(file)));
    assert.deepEqual(
      offenders,
      [],
      `${offenders.join(', ')} names the device dictionary. The local store syncs to the server in a blob.\n${RULE}`,
    );
  });

  // Check 5.
  it('is gated by routes through the gate module, never by reading the cookie', () => {
    const offenders = routeFiles.filter((file) => read(file).includes('parseDeviceDictionaryCookie'));
    assert.deepEqual(
      offenders,
      [],
      `${offenders.join(', ')} reads the device-dict cookie itself. A route calls isDeviceDictionaryDirection from ` +
        `app/lib/translation/device-dictionary-gate.ts, which answers for one direction and exposes no list.\n${RULE}`,
    );
  });

  // Check 6.
  it('adds no SQLite or IndexedDB package to package.json', () => {
    const manifest = z
      .object({
        dependencies: z.record(z.string(), z.string()).default({}),
        devDependencies: z.record(z.string(), z.string()).default({}),
        optionalDependencies: z.record(z.string(), z.string()).default({}),
        peerDependencies: z.record(z.string(), z.string()).default({}),
      })
      .parse(JSON.parse(read('package.json')));
    const names = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
      ...Object.keys(manifest.optionalDependencies),
      ...Object.keys(manifest.peerDependencies),
    ];
    assert.ok(names.length > 20, `read ${names.length} package names out of package.json, expected well over 20.\n${RULE}`);

    const offenders = names.filter((name) => FORBIDDEN_PACKAGE.test(name));
    assert.deepEqual(
      offenders,
      [],
      `package.json lists ${offenders.join(', ')}. The reader in ${ENGINE_DIRECTORY}/sqlite-table-reader.ts exists so ` +
        `that no SQL engine or storage wrapper is a dependency.\n${RULE}`,
    );
  });

  // Check 7.
  for (const file of engineFiles) {
    it(`${file} opens no connection and writes no cookie`, () => {
      const hits = outboundCalls(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} uses ${hits.join(', ')}. The cookie writer lives in app/lib/dictionary/device-dictionary-cookie.ts, ` +
          `outside this directory, on purpose.\n${RULE}`,
      );
    });
  }

  // Check 9.
  describe('offline search hands the route routing facts, never an entry', () => {
    /** The names by which a dictionary entry or a hit is carried. */
    const ENTRY_NAMES = /\bDeviceDictionaryEntry\b|\bDeviceDictionaryHit\b|\btranslations\b|\bwritten\b|\blookupDeviceEntry\b/;

    /** The interface block named `name` in `source`, comments removed, or an empty string. */
    function interfaceBlock(source: string, name: string): string {
      const pattern = new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`);
      return pattern.exec(stripComments(source))?.[0] ?? '';
    }

    it('the loader data shape names no entry field', () => {
      const view = interfaceBlock(read('app/lib/offline/offline-view.ts'), 'OfflineView');
      const info = interfaceBlock(read('app/lib/offline/offline-view.ts'), 'OfflineDictionaryInfo');
      assert.ok(view.length > 0 && info.length > 0, `the offline view interfaces moved, so this check would pass over nothing.\n${RULE}`);
      assert.doesNotMatch(view + info, ENTRY_NAMES, `the offline loader data can carry an entry.\n${RULE}`);
    });

    it('the plan the planner returns names no entry field', () => {
      const plan = interfaceBlock(read('app/lib/local-dictionary/offline-search.ts'), 'OfflineSearchPlan');
      assert.ok(plan.length > 0, `OfflineSearchPlan moved, so this check would pass over nothing.\n${RULE}`);
      assert.doesNotMatch(plan, ENTRY_NAMES, `the offline plan can carry an entry.\n${RULE}`);
    });

    it('the planner drops what it reads: no hit is stored, returned or logged', () => {
      const code = stripComments(read('app/lib/local-dictionary/offline-search.ts'));
      // The one lookup, whose result is compared with null and discarded.
      assert.equal([...code.matchAll(/lookupDeviceEntry\(/g)].length, 1, `the planner reads the store from more than one place.\n${RULE}`);
      assert.match(code, /if \(hit !== null\) return \{ from: candidate\.from, to: candidate\.to, detected: true \};/);
    });

    it('the door reports a failure without the query', () => {
      const code = stripComments(read('app/lib/offline/plan-on-device.ts'));
      assert.match(code, /reportError\(cause, \{ stage: 'plan-offline-search' \}\);/);
    });

    it('the route holds no lookup: it reaches the device only through the door', () => {
      const route = stripComments(read('app/routes/translate.tsx'));
      assert.doesNotMatch(route, ENTRY_NAMES, `the search route names a dictionary entry.\n${RULE}`);
      assert.match(route, /from '#app\/lib\/offline\/plan-on-device'/);
    });

    it('the offline result component receives a kind and facts, so it cannot draw an entry', () => {
      const component = stripComments(read('app/components/offline-search-result.tsx'));
      assert.doesNotMatch(component, ENTRY_NAMES, `the offline result component names a dictionary entry.\n${RULE}`);
      assert.equal(specifiersOf(read('app/components/offline-search-result.tsx')).some((s) => s.includes('local-dictionary')), false);
    });
  });

  // Check 8.
  it('leaves SERVED_LICENCES as exactly the three licences', () => {
    assert.deepEqual(
      [...SERVED_LICENCES],
      ['CC0-1.0', 'CC-BY-2.0-FR', 'CC-BY-4.0'],
      `the served licence list changed. The device dictionary is not a way around it, and changing it is a legal ` +
        `decision for the operator.\n${RULE}`,
    );
  });
});
