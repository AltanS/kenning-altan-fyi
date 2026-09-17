/**
 * Guard: every file under `app/routes/` is classified public or gated in
 * `app/lib/route-classification.ts`, and nothing is classified that does not
 * exist (M184 spec 03).
 *
 * WHAT THIS PROTECTS, AND WHAT IT DELIBERATELY DOES NOT
 *   It cannot check that a classification is TRUE. Nothing static can: the rule
 *   for `translate.tsx` lives inside a loader and reads the request, and the rule
 *   for `api.v1.transcribe.ts` is three lines of an action. What it CAN do is
 *   make an unclassified route file impossible to ship. The failure mode this
 *   milestone exists to prevent is not a wrong answer, it is a route nobody
 *   asked the question about, which is exactly how `/?q=` stayed open while
 *   `/translate` was being gated.
 *
 *   So the test is a forcing function with a loud remedy, not a proof. A new
 *   file fails it, and the only way to make it pass is to write down which of
 *   the seven mechanisms guards the file, which is a sentence somebody has to
 *   mean.
 *
 * BOTH DIRECTIONS ARE CHECKED. A missing entry is the important one, and a
 * STALE entry matters too: a classification for a deleted file is a line of the
 * manifest that describes nothing, and a reader auditing the public surface
 * would count it.
 *
 * THE ENUMERATION IS FROM THE FILE SYSTEM, not from `app/routes.ts`. A file
 * that exists but is not registered is precisely the kind of thing that should
 * be noticed rather than skipped, and `_admin.tsx` is one today.
 *
 * NO ENVIRONMENT PRECONDITION. This is a unit test: it reads the repository and
 * imports one module with no server imports in it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { CLASSIFIED_ROUTE_FILES, PUBLIC_ROUTE_FILES, ROUTE_CLASSIFICATION } from '../../app/lib/route-classification';

/** Resolved from this module's own location, so the working directory is irrelevant. */
const ROUTES_DIR = resolve(import.meta.dirname, '../../app/routes');

/**
 * Every route file on disk, as a path relative to `app/routes/`.
 *
 * `encoding: 'utf8'` is not decoration. Without it `recursive: true` types the
 * result as `(string | Buffer)[]`, which does not typecheck against a string
 * array and sends the next reader looking for a cast.
 *
 * `+types` is excluded: React Router's typegen writes generated declaration
 * files beside the routes, and they are not routes.
 */
function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .filter((entry) => !entry.includes('+types'))
    .map((entry) => entry.split('\\').join('/'))
    .toSorted();
}

const REMEDY =
  'Add it to ROUTE_CLASSIFICATION in app/lib/route-classification.ts with the mechanism that guards it: ' +
  "'public', 'landing-loader-split', 'gated-layout', 'gated-inline', 'bearer-token', 'module', 'unrouted' or " +
  "'dev-only'. " +
  'A route nobody classified is a route nobody decided about, and the last one of those cost this product ' +
  'an open enrichment queue at /?q=.';

describe('route classification completeness', () => {
  it('finds route files to check, so the guard cannot pass on an empty list', () => {
    assert.ok(
      listRouteFiles().length > 20,
      `Only ${listRouteFiles().length} file(s) found under ${ROUTES_DIR}. The enumeration is broken, ` +
        'and a broken enumeration makes every assertion below vacuous.',
    );
  });

  it('classifies every file under app/routes/', () => {
    const classified = new Set(CLASSIFIED_ROUTE_FILES);
    const missing = listRouteFiles().filter((file) => !classified.has(file));

    assert.deepEqual(missing, [], `Unclassified route file(s): ${missing.join(', ')}. ${REMEDY}`);
  });

  it('classifies nothing that no longer exists', () => {
    const onDisk = new Set(listRouteFiles());
    const stale = CLASSIFIED_ROUTE_FILES.filter((file) => !onDisk.has(file));

    assert.deepEqual(
      stale,
      [],
      `Classified but absent from app/routes/: ${stale.join(', ')}. Remove the entry: a classification for ` +
        'a file that does not exist is a line of the public-surface audit that describes nothing.',
    );
  });

  it('gives every entry a reason a reader can act on', () => {
    // A SENTENCE, NOT A LENGTH CONTEST. Some reasons are one clause long and
    // that is right: `requireApiKey.` names the exact function guarding the
    // route, which is all a reader needs to go and read it. What is banned is
    // an empty string or a placeholder, so the floor is low and the full stop
    // is what makes it a statement somebody wrote on purpose.
    const thin = Object.entries(ROUTE_CLASSIFICATION)
      .filter(([, classification]) => classification.reason.length < 10 || !classification.reason.endsWith('.'))
      .map(([file]) => file);

    assert.deepEqual(
      thin,
      [],
      `Entries with no usable reason: ${thin.join(', ')}. The category says WHAT, the reason says WHERE to ` +
        'look for the check, and the second one is what saves the next audit.',
    );
  });

  it('records the two inline-gated spend routes M184 closed', () => {
    // NAMED EXPLICITLY, because these two are invisible in `app/routes.ts`:
    // neither sits under a gated layout, and both spend money. A refactor that
    // quietly reclassified either one as public is the exact regression this
    // milestone exists to prevent, and a generic completeness check would not
    // notice it.
    assert.equal(ROUTE_CLASSIFICATION['api.v1.transcribe.ts'].access, 'gated-inline');
    assert.equal(ROUTE_CLASSIFICATION['api.enrichment-vote.ts'].access, 'gated-inline');
  });

  it('keeps the two explanation screens gated', () => {
    // THE ROWS ARE FREE TEXT A PERSON TYPED, which makes these two the screens
    // on this product with the most to lose from a missing gate: a search log
    // says which words somebody looked up, an ask log says what they wanted to
    // understand, in their own sentence. Both sit under `_app.gated`, and the
    // detail screen is gated a second time by its own query, which matches the
    // reader AND the id so another account's row reads as a 404.
    assert.equal(ROUTE_CLASSIFICATION['explanations.tsx'].access, 'gated-layout');
    assert.equal(ROUTE_CLASSIFICATION['explanations.$id.tsx'].access, 'gated-layout');
    assert.ok(!PUBLIC_ROUTE_FILES.includes('explanations.tsx'));
    assert.ok(!PUBLIC_ROUTE_FILES.includes('explanations.$id.tsx'));
  });

  it('keeps translate.tsx gated, and keeps the front door beside it public', () => {
    // `translate.tsx` was `landing-loader-split` until M199: half public, half
    // gated, decided per request. The public half is `/welcome` now, so the
    // file is gated for every signed-out caller and the honest category is
    // `gated-inline`. It is NOT `gated-layout`: the `_app.gated` block reaches
    // the `/translate` alias only, and `/` is gated by the rule inside the one
    // loader they share. Calling it `gated-layout` here is how somebody comes
    // to delete that rule and reopen `/?q=`.
    assert.equal(ROUTE_CLASSIFICATION['translate.tsx'].access, 'gated-inline');
    assert.equal(ROUTE_CLASSIFICATION['explain.tsx'].access, 'gated-layout');

    // And the door it sends a stranger to has to stay open, or the redirect is
    // a loop: `/welcome` refuses nobody, it only forwards a reader who is
    // already signed in.
    assert.equal(ROUTE_CLASSIFICATION['welcome.tsx'].access, 'public');
    assert.ok(PUBLIC_ROUTE_FILES.includes('welcome.tsx'));
  });
});
