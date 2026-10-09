/**
 * `offlineResultKind`, which calm screen the offline result region draws.
 *
 * The order is the point. A phrase and a direction with no dictionary are decided
 * BEFORE the lookup, because the lookup cannot say anything about them, and a
 * lookup that has not settled draws nothing so a miss never flashes before a hit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  offlineResultKind,
  type OfflineDictionaryInfo,
  type OfflineLookupStatus,
  type OfflineView,
} from '#app/lib/offline/offline-view';

const EN_DE: OfflineDictionaryInfo = { pair: 'en-de', from: 'en', to: 'de', entryCount: 10 };

/** A device holding en-de, with the text a phrase or not. */
function view(overrides: Partial<OfflineView> = {}): OfflineView {
  return { isPhrase: false, dictionaries: [EN_DE], ...overrides };
}

function kind(options: { q?: string; offline?: OfflineView; lookup?: OfflineLookupStatus; to?: 'de' | 'en' }) {
  return offlineResultKind({
    q: options.q ?? 'house',
    direction: { from: 'en', to: options.to ?? 'de' },
    offline: options.offline ?? view(),
    lookup: options.lookup ?? 'idle',
  });
}

describe('offlineResultKind', () => {
  it('is the overview when nothing was searched, whatever else is true', () => {
    assert.equal(kind({ q: '', lookup: 'hit' }), 'overview');
    assert.equal(kind({ q: '', offline: view({ dictionaries: [] }) }), 'overview');
  });

  it('is a phrase before the lookup is consulted', () => {
    assert.equal(kind({ q: 'the house', offline: view({ isPhrase: true }), lookup: 'hit' }), 'phrase');
  });

  it('says no dictionary translates this way before the lookup is consulted', () => {
    assert.equal(kind({ to: 'en', lookup: 'miss' }), 'no-dictionary');
    assert.equal(kind({ offline: view({ dictionaries: [] }), lookup: 'miss' }), 'no-dictionary');
  });

  it('draws nothing while the lookup has not settled', () => {
    assert.equal(kind({ lookup: 'loading' }), 'checking');
    assert.equal(kind({ lookup: 'idle' }), 'checking');
  });

  it('is answered on a hit and a miss on a miss', () => {
    assert.equal(kind({ lookup: 'hit' }), 'answered');
    assert.equal(kind({ lookup: 'miss' }), 'miss');
  });
});
