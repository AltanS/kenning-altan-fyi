/**
 * Guard: a terminal write says how THIS attempt ended, and never how the last
 * one did.
 *
 * WHAT THIS PROTECTS. pg-boss retries a timed-out explain job on the SAME row,
 * so the first attempt writes `failed` with a timeout message and the retry
 * writes `ok` with a full answer. While the write set `error` only when one was
 * passed, the timeout message survived the success: row
 * `73d9fe0f-3bf1-4752-a0e3-0dacc557e8cc` on the dev database is `status = 'ok'`,
 * carrying an answer, carrying `Request timed out after 90019ms`. Nothing on the
 * reader's screen showed it, and every operator surface that reads the column
 * reported a failure that did not happen.
 *
 * THE SHAPE IS ASSERTED, NOT THE SQL. `explanationTerminalValues` is the object
 * handed to `.set()`, so the absence of a key is exactly what leaves a column
 * alone. Asserting through a database would need one; asserting the value needs
 * nothing.
 *
 * NO ENVIRONMENT PRECONDITION. The module imports only types from `#drizzle`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { explanationTerminalValues } from '../../app/models/explanations.server';
import type { Explanation } from '../../app/lib/llm/explain-schema';

/** The smallest answer the schema accepts, which is all this file needs. */
const ANSWER: Explanation = {
  answer: 'kennen is about people, wissen is about facts.',
  terms: [],
  contrasts: [],
  pitfalls: [],
  related: [],
  references: [],
};

const FINISHED_AT = new Date('2026-09-17T10:00:00.000Z');

describe('explanationTerminalValues', () => {
  it('clears the previous attempt error when a retry succeeds', () => {
    const values = explanationTerminalValues(
      { status: 'ok', answer: ANSWER, costUsd: 0.0123, latencyMs: 4200 },
      FINISHED_AT,
    );

    assert.equal(values.status, 'ok');
    assert.equal(values.error, null);
    assert.equal(values.answer, ANSWER);
    assert.equal(values.costUsd, '0.012300');
    assert.equal(values.latencyMs, 4200);
    assert.equal(values.finishedAt, FINISHED_AT);
  });

  it('keeps the message a failed run reports', () => {
    const values = explanationTerminalValues({ status: 'failed', error: 'the model refused' }, FINISHED_AT);

    assert.equal(values.status, 'failed');
    assert.equal(values.error, 'the model refused');
    assert.equal(values.answer, undefined);
  });

  it('writes no answer and no cost on a refused run, so neither column is touched', () => {
    const values = explanationTerminalValues({ status: 'budget', error: 'the daily budget is used up' }, FINISHED_AT);

    assert.equal(values.error, 'the daily budget is used up');
    assert.equal('answer' in values, false);
    assert.equal('costUsd' in values, false);
    assert.equal('latencyMs' in values, false);
  });

  it('writes a null cost, because null means the call ran and nothing could price it', () => {
    const values = explanationTerminalValues({ status: 'ok', answer: ANSWER, costUsd: null }, FINISHED_AT);

    assert.equal('costUsd' in values, true);
    assert.equal(values.costUsd, null);
  });
});
