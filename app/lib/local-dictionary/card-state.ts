/**
 * card-state.ts, the import state machine behind the settings card.
 *
 * PURE ON PURPOSE. The settings card reads a file, builds a word list and writes
 * it to IndexedDB, and every one of those steps is a browser effect the unit
 * tests cannot run. What CAN go wrong in a way a reader notices, a name that
 * is refused, a progress bar that runs backwards, a failure that leaves a
 * "finished" line on screen, is a question about ORDER, and order is data. So
 * the card holds one reducer over this state, drives it from its handlers, and
 * the cases in `tests/unit/local-dictionary-card-state.test.ts` walk it with
 * plain objects.
 *
 * THE PHASES, IN THE ONLY ORDER THEY MAY HAPPEN
 *   idle -> reading -> indexing -> saving -> done
 * with `failed` reachable from any of the three busy phases, and from `idle`
 * when the file NAME is refused before any byte is read. `done` and `failed`
 * are both resting states: choosing another file starts again from either.
 *
 * AN ACTION OUT OF ORDER CHANGES NOTHING. A late `save-progress` after a failure
 * must not resurrect a progress bar, and a second file chosen mid-import must not
 * restart one. The reducer answers the state it was given, and the component's
 * input is disabled while busy besides.
 *
 * A FAILURE KEEPS NOTHING. `failed` carries a reason and no pair, no count and
 * no progress, so no screen can print half a result under an error. Whatever the
 * store was left holding is the component's job to clear, because that is
 * IndexedDB, and this file touches none.
 *
 * THE DIRECTION COMES FROM THE FILE NAME and is never asked for. The reducer
 * applies the same `parseWikdictFileName` the importer uses, so the card cannot
 * accept a name the importer would then reject.
 */

import { deviceDictionaryPairKey } from '#app/lib/dictionary/device-dictionary-cookie';
import { parseWikdictFileName } from './wikdict';

/** Why an import ended without a dictionary. */
export type ImportFailureReason =
  /** The file name is not a served `xx-yy.sqlite3`. Nothing was read. */
  | 'file-name'
  /** The bytes are not a WikDict file this app can read. */
  | 'unreadable'
  /** The file is readable and holds no usable word. */
  | 'empty'
  /** The device would not keep the dictionary. */
  | 'storage';

/** Where the card's import is. */
export type DeviceDictionaryCardState =
  | { phase: 'idle' }
  | { phase: 'reading'; pair: string }
  | { phase: 'indexing'; pair: string }
  | { phase: 'saving'; pair: string; written: number; total: number }
  | { phase: 'done'; pair: string; entryCount: number }
  | { phase: 'failed'; reason: ImportFailureReason };

/** Everything that can happen to the card's import. */
export type DeviceDictionaryCardAction =
  | { type: 'file-chosen'; fileName: string }
  | { type: 'read-finished' }
  | { type: 'index-built'; total: number }
  | { type: 'save-progress'; written: number; total: number }
  | { type: 'save-finished'; entryCount: number }
  | { type: 'import-failed'; reason: ImportFailureReason }
  | { type: 'dismissed' };

/** The state a card starts in, and returns to. */
export const IDLE_CARD_STATE: DeviceDictionaryCardState = { phase: 'idle' };

/**
 * Whether an import is in flight, so the card should refuse another file.
 *
 * @param state The card's current state.
 */
export function isImportBusy(state: DeviceDictionaryCardState): boolean {
  return state.phase === 'reading' || state.phase === 'indexing' || state.phase === 'saving';
}

/**
 * A file was chosen: refuse its name or start reading it.
 *
 * @param state The state before the choice.
 * @param fileName The chosen file's name, never its path.
 */
function chooseFile(state: DeviceDictionaryCardState, fileName: string): DeviceDictionaryCardState {
  if (isImportBusy(state)) return state;
  const direction = parseWikdictFileName(fileName);
  if (direction === null) return { phase: 'failed', reason: 'file-name' };
  return { phase: 'reading', pair: deviceDictionaryPairKey(direction.from, direction.to) };
}

/**
 * Move the card's import one step.
 *
 * @param state The state before the action.
 * @param action What happened.
 * @returns The next state, or `state` itself when the action is not allowed here.
 */
export function reduceDeviceDictionaryCard(
  state: DeviceDictionaryCardState,
  action: DeviceDictionaryCardAction,
): DeviceDictionaryCardState {
  switch (action.type) {
    case 'file-chosen':
      return chooseFile(state, action.fileName);
    case 'read-finished':
      return state.phase === 'reading' ? { phase: 'indexing', pair: state.pair } : state;
    case 'index-built':
      return state.phase === 'indexing' ? { phase: 'saving', pair: state.pair, written: 0, total: action.total } : state;
    case 'save-progress':
      return state.phase === 'saving' ?
          { phase: 'saving', pair: state.pair, written: action.written, total: action.total }
        : state;
    case 'save-finished':
      return state.phase === 'saving' ? { phase: 'done', pair: state.pair, entryCount: action.entryCount } : state;
    case 'import-failed':
      return isImportBusy(state) ? { phase: 'failed', reason: action.reason } : state;
    case 'dismissed':
      return state.phase === 'done' || state.phase === 'failed' ? IDLE_CARD_STATE : state;
  }
}
