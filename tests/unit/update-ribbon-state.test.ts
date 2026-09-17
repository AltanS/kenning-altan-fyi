/**
 * Guard: what the update ribbon says, decided outside the JSX.
 *
 * `ribbonState` is the seam that lets this be a unit test at all: the component
 * renders whatever it is handed, and the CHOICE lives in a pure function. A
 * condition written into the markup instead would need a DOM and a rendered
 * tree to check, which is how a banner ends up shipping with nobody having run
 * the case where it must stay quiet.
 *
 * THE QUIET CASE IS THE IMPORTANT ONE. A ribbon that appears when it should
 * not is worse than one that never appears: it asks the reader to reload a page
 * that is already current, and taking the offer does not make it go away.
 *
 * NO ENVIRONMENT PRECONDITION. The function is pure and the snapshot is a
 * plain object.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ribbonState, type UpdateSnapshot } from '../../app/lib/update-store';

describe('ribbonState', () => {
  it('says nothing before any poll has come back', () => {
    const fresh: UpdateSnapshot = { bundleStale: false };
    assert.equal(ribbonState(fresh), 'none');
  });

  it('offers the reload once this page is behind the server', () => {
    const stale: UpdateSnapshot = { bundleStale: true };
    assert.equal(ribbonState(stale), 'newer-bundle');
  });
});
