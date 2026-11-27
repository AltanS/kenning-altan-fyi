/**
 * "Hide translations", and the items the reader has revealed under it, both
 * remembered per room for as long as the tab lives.
 *
 * CLIENT ONLY BY CONSTRUCTION. The screen reads it through
 * `useSyncExternalStore` with a server answer of "shown", so the server and the
 * first client render agree and the stored value is applied right after.
 *
 * Storage can be refused (a blocked or full store). The choice then lives in
 * memory, so the switch still works until the page is reloaded.
 */

const HIDDEN_PREFIX = 'kenning-room-hidden:';
const REVEALED_PREFIX = 'kenning-room-revealed:';

/** The values storage refused to take, by full key. They win over what storage holds. */
const unstored = new Map<string, string>();
const listeners = new Set<() => void>();

export function subscribeToPracticePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readValue(key: string): string {
  const held = unstored.get(key);
  if (held !== undefined) return held;
  try {
    return globalThis.sessionStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeValue({ key, value }: { key: string; value: string }): void {
  try {
    globalThis.sessionStorage.setItem(key, value);
    unstored.delete(key);
  } catch {
    unstored.set(key, value);
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Whether this room's translations are covered. */
export function readTranslationsHidden(roomId: string): boolean {
  return readValue(`${HIDDEN_PREFIX}${roomId}`) === '1';
}

export interface TranslationsHiddenParams {
  roomId: string;
  isHidden: boolean;
}

/** Flip the switch. Either way round, nothing stays revealed. */
export function writeTranslationsHidden({ roomId, isHidden }: TranslationsHiddenParams): void {
  writeValue({ key: `${HIDDEN_PREFIX}${roomId}`, value: isHidden ? '1' : '0' });
  writeValue({ key: `${REVEALED_PREFIX}${roomId}`, value: '' });
  notify();
}

/** One term, sentence or rule of one room. Item ids hold no spaces, which is how they are listed. */
export interface RoomItem {
  roomId: string;
  itemId: string;
}

function revealedIds(roomId: string): string[] {
  return readValue(`${REVEALED_PREFIX}${roomId}`).split(' ').filter(Boolean);
}

/** Whether the reader has asked to see this item's translation. */
export function readItemRevealed({ roomId, itemId }: RoomItem): boolean {
  return revealedIds(roomId).includes(itemId);
}

export function revealItem({ roomId, itemId }: RoomItem): void {
  const ids = revealedIds(roomId);
  if (ids.includes(itemId)) return;
  writeValue({ key: `${REVEALED_PREFIX}${roomId}`, value: [...ids, itemId].join(' ') });
  notify();
}
