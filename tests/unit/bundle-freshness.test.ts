/**
 * Guard: the rule that decides whether this page is behind the server.
 *
 * WHY THIS RULE IS WORTH A TEST. It is the whole feature. Everything else in
 * the update path is plumbing around the two decisions made here, and both of
 * them are decisions about what NOT to report.
 *
 * ONE MISMATCH IS NOT STALE. Bay pulls one image and restarts the container,
 * and for a few seconds a tab can be answered by the old process, then the new
 * one, then the old one again. A ribbon keyed on the first disagreement offers
 * a reload onto the build the reader is already running, and then offers it
 * again on the next poll. That failure is invisible in a screenshot: the banner
 * looks correct, it is just about nothing.
 *
 * UNKNOWN IS NOT EVIDENCE. A build with no git and no override stamps the word
 * `unknown`. Counting that as a mismatch would make an unstamped build nag on
 * its second poll, forever, with no reload that could ever clear it.
 *
 * NO ENVIRONMENT PRECONDITION, AND NO CLOCK. `observeServerBuild` is pure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FRESH_BUNDLE, observeServerBuild, type BundleFreshness } from '../../app/lib/bundle-freshness';

/** This page's commit, for every case below. */
const BUNDLE = 'aaaaaaa';

/** Folds one server answer in, so a case reads as the sequence it is. */
function observe(state: BundleFreshness, serverSha: string | null): BundleFreshness {
  return observeServerBuild({ state, serverSha, bundleSha: BUNDLE });
}

describe('observeServerBuild', () => {
  it('reports nothing when the server is running this very bundle', () => {
    const state = observe(FRESH_BUNDLE, BUNDLE);
    assert.equal(state.mismatches, 0);
    assert.equal(state.isStale, false);
  });

  it('does not call one mismatch stale, because a restart flaps', () => {
    const state = observe(FRESH_BUNDLE, 'bbbbbbb');
    assert.equal(state.mismatches, 1);
    assert.equal(state.isStale, false);
  });

  it('calls two consecutive mismatches stale', () => {
    const first = observe(FRESH_BUNDLE, 'bbbbbbb');
    const second = observe(first, 'bbbbbbb');
    assert.equal(second.mismatches, 2);
    assert.equal(second.isStale, true);
  });

  it('keeps counting past the threshold and stays stale', () => {
    const third = observe(observe(observe(FRESH_BUNDLE, 'bbbbbbb'), 'bbbbbbb'), 'ccccccc');
    assert.equal(third.mismatches, 3);
    assert.equal(third.isStale, true);
  });

  it('resets on a match, so the two have to be CONSECUTIVE', () => {
    const mismatched = observe(FRESH_BUNDLE, 'bbbbbbb');
    const matched = observe(mismatched, BUNDLE);
    assert.deepEqual(matched, FRESH_BUNDLE);

    // One more mismatch after the reset is a first mismatch again, not a second.
    assert.equal(observe(matched, 'bbbbbbb').isStale, false);
  });

  it('resets when the SERVER could not name its commit', () => {
    const mismatched = observe(FRESH_BUNDLE, 'bbbbbbb');
    assert.deepEqual(observe(mismatched, 'unknown'), FRESH_BUNDLE);
  });

  it('resets when the server answered nothing at all', () => {
    const mismatched = observe(FRESH_BUNDLE, 'bbbbbbb');
    assert.deepEqual(observe(mismatched, null), FRESH_BUNDLE);
    assert.deepEqual(observe(mismatched, ''), FRESH_BUNDLE);
  });

  it('reports nothing when THIS BUNDLE could not name its commit', () => {
    // An unstamped bundle against a perfectly well stamped server. Two polls,
    // so a rule that only checked the server side would have fired by now.
    const first = observeServerBuild({ state: FRESH_BUNDLE, serverSha: 'bbbbbbb', bundleSha: 'unknown' });
    const second = observeServerBuild({ state: first, serverSha: 'bbbbbbb', bundleSha: 'unknown' });
    assert.equal(second.isStale, false);
  });
});
