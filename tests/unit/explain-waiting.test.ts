/**
 * Guard: the explain waiting sentence changes as the wait goes on (M198).
 *
 * DESIGN.md SECTION 7 IS THE RULE: a long operation shows phased status copy,
 * never one line for the whole of it. An explain call is the slowest thing this
 * app makes, and the phases are the only thing on the screen that tells a reader
 * a slow answer from a dead one. A regression here is silent, because one
 * sentence forever still reads as a working screen for the first five seconds,
 * which is as long as anybody looks while testing it.
 *
 * THE PHASE COMES FROM THE SHARED MACHINE AND ONLY THE SENTENCE IS THIS
 * SCREEN'S, so the case below walks `waitPhaseFor` into `explainWaitingKey`
 * rather than asserting a threshold of its own. Two tables of thresholds would
 * be two ideas of how long a run has been waiting, and the translator already
 * owns the one that exists.
 *
 * NO ENVIRONMENT PRECONDITION, AND NO CLOCK. Both functions are pure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { explainWaitingKey } from '../../app/lib/translation/explain-pane';
import { waitPhaseFor } from '../../app/lib/translation/pane-state';

/** The sentence a wait of this many milliseconds shows, through both seams. */
function keyAfter(elapsedMs: number): string {
  return explainWaitingKey(waitPhaseFor(elapsedMs));
}

describe('the explain waiting copy', () => {
  it('starts by naming the question', () => {
    assert.equal(keyAfter(0), 'explain.waitingThinking');
    assert.equal(keyAfter(7_999), 'explain.waitingThinking');
  });

  it('moves to the writing phase at eight seconds', () => {
    assert.equal(keyAfter(8_000), 'explain.waitingWriting');
    assert.equal(keyAfter(24_999), 'explain.waitingWriting');
  });

  it('moves to the examples phase at twenty-five seconds, and stays there', () => {
    assert.equal(keyAfter(25_000), 'explain.waitingExamples');
    assert.equal(keyAfter(600_000), 'explain.waitingExamples');
  });

  it('gives every phase its own sentence', () => {
    // THREE PHASES, THREE KEYS. A table that mapped two phases to one sentence
    // would pass every case above and still show a reader the same line for
    // twenty seconds, which is the defect the phasing exists to remove.
    const keys = new Set((['first', 'second', 'third'] as const).map((phase) => explainWaitingKey(phase)));
    assert.equal(keys.size, 3);
  });
});
