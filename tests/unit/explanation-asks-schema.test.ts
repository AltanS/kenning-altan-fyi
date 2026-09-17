/**
 * Guard: the ask log carries the reader and the answer ledger does not (M198).
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. `explanations` is deliberately
 * readerless: it is keyed by the question, it is shared between every reader who
 * asks the same thing, and an operator reading it while debugging a run must not
 * be reading a transcript of who asked what. That invariant is one column away
 * from being lost, and the loss would look like a helpful convenience, `just add
 * user_id so the list screen can join`. So the absence is asserted rather than
 * argued, and the second table is asserted to exist beside it.
 *
 * THE IDENTITY IS ASSERTED COLUMN FOR COLUMN, because it is what makes a repeat
 * MOVE a row instead of adding one. Drop `question_normalized` from it and one
 * reader's log fills with the same question under four spellings; drop the
 * languages and the same question asked in two pairs collapses into one row that
 * names the wrong one.
 *
 * NO ENVIRONMENT PRECONDITION. It reads Drizzle's own table metadata, which is
 * a plain object built at import time. The schema modules open no pool.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { explanationAsks } from '../../drizzle/schema/explanation-asks';
import { explanations } from '../../drizzle/schema/explanations';

const asks = getTableConfig(explanationAsks);
const ledger = getTableConfig(explanations);

/** The columns of one index, in order, as the migration writes them. */
function indexColumns(name: string): string[] {
  const index = asks.indexes.find((candidate) => candidate.config.name === name);
  assert.ok(index !== undefined, `explanation_asks has no index called ${name}.`);
  return (index.config.columns ?? []).map((column) => ('name' in column ? String(column.name) : String(column)));
}

describe('the explanation ask log', () => {
  it('is its own table, beside the ledger rather than inside it', () => {
    assert.equal(asks.name, 'explanation_asks');
    assert.equal(ledger.name, 'explanations');
  });

  it('names the reader, and the answer ledger names nobody', () => {
    const askColumns = asks.columns.map((column) => column.name);
    assert.ok(askColumns.includes('user_id'), 'The ask log lost its reader, so nothing can say what anybody asked.');

    const ledgerColumns = new Set(ledger.columns.map((column) => column.name));
    for (const forbidden of ['user_id', 'account_id', 'session_id', 'device_id']) {
      assert.ok(
        !ledgerColumns.has(forbidden),
        `explanations grew a "${forbidden}" column. That table is a shared cache keyed by the question and it ` +
          'must describe no reader: see its own file header, and app/models/explanation-asks.server.ts for the ' +
          'table that is allowed to.',
      );
    }
  });

  it('erases a reader’s asks with the reader', () => {
    const [reference] = asks.foreignKeys;
    assert.ok(reference !== undefined, 'The ask log has no foreign key, so deleting an account leaves its questions behind.');
    assert.equal(reference.onDelete, 'cascade');
  });

  it('identifies an ask by the reader, the pair and the folded question', () => {
    assert.deepEqual(indexColumns('explanation_asks_identity_idx'), [
      'user_id',
      'from_language',
      'to_language',
      'question_normalized',
    ]);
  });

  it('serves the one read shape the list screen uses', () => {
    assert.deepEqual(indexColumns('explanation_asks_user_asked_idx'), ['user_id', 'asked_at']);
  });
});
