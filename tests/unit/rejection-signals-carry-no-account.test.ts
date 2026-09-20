/**
 * Guard: the rejection signal names nobody, and the fact beside it does.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. `translation_rejection_signals` is the
 * row a fine-tuning corpus reads, and it is deliberately readerless: the fact
 * table knows WHO rejected a run, this table knows WHAT was wrong with it, and
 * nothing joins them in an export. That invariant is ONE COLUMN away from being
 * lost, and the loss would arrive looking like a convenience, "just put
 * account_id on the signal so one insert does the whole job". So the absence is
 * asserted rather than argued, and the table that is allowed to name a reader
 * is asserted to still do so beside it.
 *
 * It is the same shape of guard as
 * `tests/unit/explanation-listing-no-user-filter.test.ts` and
 * `tests/unit/explanation-asks-schema.test.ts`: a permanent product rule read
 * off the schema, where prose alone would be quietly reopened by the next
 * feature.
 *
 * THE BAN IS ON A SUBSTRING, NOT A LIST OF NAMES. `account_id` and `user_id`
 * are the two names somebody would reach for first, but `rejected_by_user`,
 * `reporter_account` and `asking_user_id` are the same column with a friendlier
 * label. Anything holding `account` or `user` fails, so a new column has to be
 * argued here before it can be added there.
 *
 * NO ENVIRONMENT PRECONDITION. It reads Drizzle's own table metadata, which is
 * a plain object built at import time. The schema modules open no pool.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  translationRejectionSignals,
  translationRejections,
} from '../../drizzle/schema/translation-feedback';

const signals = getTableConfig(translationRejectionSignals);
const facts = getTableConfig(translationRejections);

describe('the rejection signal', () => {
  it('is its own table, beside the fact rather than inside it', () => {
    assert.equal(signals.name, 'translation_rejection_signals');
    assert.equal(facts.name, 'translation_rejections');
  });

  it('carries no column naming a reader', () => {
    for (const column of signals.columns) {
      const name = column.name.toLowerCase();
      for (const forbidden of ['account', 'user']) {
        assert.ok(
          !name.includes(forbidden),
          `translation_rejection_signals grew a "${column.name}" column. That table is the corpus tally and it ` +
            'must describe no reader: see its own file header, and app/models/translation-rejections.server.ts ' +
            'for the table that is allowed to.',
        );
      }
    }
  });

  it('has no foreign key onto the account table', () => {
    for (const reference of signals.foreignKeys) {
      const target = getTableConfig(reference.reference().foreignTable).name;
      assert.notEqual(
        target,
        'users',
        'translation_rejection_signals points at the account table. The signal must reach a run and nothing else.',
      );
    }
  });

  it('holds the reason as a checked code', () => {
    const constraint = signals.checks.find(
      (candidate) => candidate.name === 'translation_rejection_signals_reason_check',
    );
    assert.ok(constraint !== undefined, 'The reason lost its check constraint, so any string is now a reason code.');
  });
});

describe('the rejection fact', () => {
  it('still names the reader, so a second press can be refused', () => {
    const columns = facts.columns.map((column) => column.name);
    assert.ok(
      columns.includes('account_id'),
      'The fact table lost its reader, so nothing can stop one person rejecting the same run all afternoon.',
    );
  });

  it('erases a reader’s rejections with the reader', () => {
    const reference = facts.foreignKeys.find(
      (candidate) => getTableConfig(candidate.reference().foreignTable).name === 'users',
    );
    assert.ok(reference !== undefined, 'The fact table has no key onto the account, so deleting one leaves rows behind.');
    assert.equal(reference.onDelete, 'cascade');
  });
});
