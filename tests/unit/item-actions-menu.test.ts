/**
 * The overflow menu's one decision, checked with no DOM.
 *
 * `resolveItemActions` is what turns a caller's list, which carries a `null`
 * wherever an item does not get a row, into the rows the menu draws. The two
 * things worth pinning are that a `null` never becomes an empty row and that a
 * destructive row is last whatever order the caller wrote it in, because a
 * mis-tap must not land on the row that deletes something. Inside the JSX both
 * would be untestable here: this repo has no DOM test environment.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDestructiveItemAction,
  resolveItemActions,
  type ItemAction,
} from '#app/components/item-actions-menu';

const open: ItemAction = { kind: 'link', key: 'open', label: 'Open', to: '/x' };
const copy: ItemAction = {
  kind: 'copy',
  key: 'copy',
  label: 'Copy',
  text: 'hello',
  successMessage: 'Copied.',
  errorMessage: 'Refused.',
};
const rerun: ItemAction = { kind: 'button', key: 'rerun', label: 'Run again', onSelect: () => {} };
const remove: ItemAction = {
  kind: 'confirm',
  key: 'remove',
  label: 'Remove',
  destructive: true,
  title: 'Remove this?',
  description: 'It goes away.',
  confirmText: 'Remove',
  cancelText: 'Cancel',
};

describe('isDestructiveItemAction', () => {
  it('reads the flag on the two kinds that can carry one', () => {
    assert.equal(isDestructiveItemAction(remove), true);
    assert.equal(isDestructiveItemAction({ ...rerun, destructive: true }), true);
  });

  it('answers false for a row that never destroys anything', () => {
    assert.equal(isDestructiveItemAction(open), false);
    assert.equal(isDestructiveItemAction(copy), false);
    assert.equal(isDestructiveItemAction(rerun), false);
  });
});

describe('resolveItemActions', () => {
  it('drops the rows this item does not get', () => {
    const rows = resolveItemActions([open, null, copy]);
    assert.deepEqual(
      rows.map((row) => row.key),
      ['open', 'copy'],
    );
  });

  it('keeps the caller order among the rows that stay', () => {
    const rows = resolveItemActions([copy, open, rerun]);
    assert.deepEqual(
      rows.map((row) => row.key),
      ['copy', 'open', 'rerun'],
    );
  });

  it('moves a destructive row to the end whatever order it arrived in', () => {
    const rows = resolveItemActions([remove, open, copy]);
    assert.deepEqual(
      rows.map((row) => row.key),
      ['open', 'copy', 'remove'],
    );
  });

  it('keeps two destructive rows in the caller order, still last', () => {
    const second: ItemAction = { ...remove, key: 'purge' };
    const rows = resolveItemActions([remove, open, second]);
    assert.deepEqual(
      rows.map((row) => row.key),
      ['open', 'remove', 'purge'],
    );
  });

  it('answers with nothing when every row was null', () => {
    assert.deepEqual(resolveItemActions([null, null]), []);
  });
});
