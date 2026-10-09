/**
 * Who may write and who may clear the signed-in hint.
 *
 * THE RULE THIS HOLDS IN PLACE. The hint names the account whose data a device
 * holds, and it is cleared only by a deliberate sign-out. An expired session, a
 * 401, a 412 and a redirect pause sync and clear nothing. The easiest way to
 * break that is one innocent `clearSignedInHint()` in a handler that "knows" the
 * session is dead, which brings back the original defect: the offline shell
 * loses its tabs and the next account to sign in merges into the first one's
 * data. So the writers are listed here, and a new one fails the build until the
 * list, the hint module's header and this test are all changed together.
 *
 * The scan reads source text, the way `design-rules.test.ts` does, and walks the
 * tree rather than a hardcoded file list so a new file is covered the day it is
 * added.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The one module that defines these functions. It is not a caller. */
const HINT_MODULE = 'app/lib/auth/signed-in-hint.ts';

/** Every source file under `app/`, as a path relative to the repo root. */
function appSources(): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry.name)) found.push(relative(REPO_ROOT, full));
    }
  };
  visit(join(REPO_ROOT, 'app'));
  return found.toSorted();
}

/** The files, other than the hint module, whose text mentions `name`. */
function filesMentioning(name: string): string[] {
  return appSources()
    .filter((file) => file !== HINT_MODULE)
    .filter((file) => readFileSync(join(REPO_ROOT, file), 'utf8').includes(name));
}

/** The files that IMPORT `name`, which is what a header comment mentioning it does not do. */
function filesImporting(name: string): string[] {
  const importOfName = new RegExp(String.raw`import\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*'#app/lib/auth/signed-in-hint'`);
  return appSources()
    .filter((file) => file !== HINT_MODULE)
    .filter((file) => importOfName.test(readFileSync(join(REPO_ROOT, file), 'utf8')));
}

describe('who clears the signed-in hint', () => {
  it('only sign-out.tsx imports clearSignedInHint', () => {
    assert.deepEqual(filesImporting('clearSignedInHint'), ['app/routes/sign-out.tsx']);
  });

  it('the old writer is gone everywhere', () => {
    assert.deepEqual(filesImporting('writeSignedInHint'), []);
  });

  it('_app.tsx imports neither the old writer nor the clearer', () => {
    const source = readFileSync(join(REPO_ROOT, 'app/routes/_app.tsx'), 'utf8');
    assert.ok(!source.includes('writeSignedInHint'));
    assert.ok(!source.includes('clearSignedInHint'));
  });

  it('the sync client no longer clears the hint on a 401', () => {
    const source = readFileSync(join(REPO_ROOT, 'app/components/account/sync-client.ts'), 'utf8');
    assert.ok(!source.includes('clearSignedInHint'));
  });
});

describe('who writes the signed-in hint', () => {
  it('only the _app.tsx confirm effect confirms it against a server answer', () => {
    assert.deepEqual(filesImporting('confirmSignedInHint'), ['app/routes/_app.tsx']);
  });

  it('only the pause helper and sign-out.tsx set a pause', () => {
    assert.deepEqual(filesImporting('setSyncPause'), ['app/lib/sync/session-pause.ts', 'app/routes/sign-out.tsx']);
  });

  it('only the erase flow replaces the hint', () => {
    assert.deepEqual(filesImporting('replaceSignedInHint'), ['app/lib/sync/erase-other-account.ts']);
  });

  it('no file outside the hint module writes the storage key by hand', () => {
    assert.deepEqual(filesMentioning('kenning-signed-in-hint'), []);
  });
});
