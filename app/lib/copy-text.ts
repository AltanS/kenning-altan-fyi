/**
 * Putting one string on the clipboard, on every origin this app is opened from.
 *
 * WHY THIS IS NOT ONE CALL TO `navigator.clipboard`. That API exists only in a
 * secure context: HTTPS, or `localhost`. A phone opening the dev server at
 * `http://bluefin:3210` is neither, so `navigator.clipboard` is undefined there
 * and every copy control on the page was drawn permanently disabled, with
 * nothing on screen saying why. The older, deprecated path, a hidden field plus
 * `document.execCommand('copy')`, still works on exactly those origins, so it is
 * the fallback rather than a second-class option.
 *
 * THE DECISION IS SPLIT FROM THE DOM WORK, and that is what makes the decision
 * testable: `copyTextWith` is a pure choice over a port and `browserClipboard`
 * is the only thing in this file that touches a document. This repo's unit tier
 * has no DOM, so a fallback tested through the real `document` could not be
 * tested at all.
 */

/**
 * The two ways a string can reach the clipboard, as one port.
 *
 * `writeText` is null rather than absent on an origin that does not carry the
 * async API, so a caller cannot forget to handle the case: there is always a
 * value to look at.
 */
export interface ClipboardPort {
  /** The async clipboard API's writer, or null where the API is not available. */
  writeText: ((text: string) => Promise<void>) | null;
  /** The hidden-field fallback. Returns whether the copy command took. */
  copyBySelection: (text: string) => boolean;
}

/**
 * Copy one string, choosing between the two ways it can be done.
 *
 * A REJECTED `writeText` FALLS THROUGH RATHER THAN FAILING. A browser can refuse
 * the async API for a reason the older path does not share, a denied permission
 * or a document that lost focus, and the reader asked for their text rather than
 * for a particular API. Only a fallback that also fails is a failure.
 *
 * @param text What to copy. An empty string is refused: there is nothing to put
 *   on a clipboard, and reporting success would be a lie.
 * @param port Where the two ways come from.
 * @returns Whether the text is now on the clipboard. It never throws, so the
 *   caller has exactly one thing to branch on.
 */
export async function copyTextWith(text: string, port: ClipboardPort): Promise<boolean> {
  if (text === '') return false;

  const { writeText } = port;
  if (writeText !== null) {
    const written = await writeText(text).then(
      () => true,
      () => false,
    );
    if (written) return true;
  }

  return port.copyBySelection(text);
}

/**
 * The fallback, as the browser performs it.
 *
 * THE FIELD IS OFFSCREEN AND READ-ONLY, not `display: none`. A hidden element
 * cannot hold a selection, so the copy command would have nothing to take, and a
 * focusable field scrolled into view would jump the page under the reader's
 * thumb. `readonly` keeps a soft keyboard from opening on a phone during the one
 * frame the field exists.
 *
 * THE READER'S OWN SELECTION IS PUT BACK. Selecting the hidden field discards
 * whatever the reader had highlighted, which on a page of prose is the thing
 * they were about to copy by hand.
 */
function copyBySelection(text: string): boolean {
  const doc: Document | undefined = globalThis.document;
  if (doc === undefined) return false;

  const field = doc.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '-9999px';
  doc.body.append(field);

  const selection = doc.getSelection();
  const previous = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  field.select();
  field.setSelectionRange(0, text.length);

  // `execCommand` is deprecated and throws on some engines rather than
  // answering false, so both endings are read as "it did not take".
  let copied = false;
  try {
    copied = doc.execCommand('copy');
  } catch {
    copied = false;
  }

  field.remove();
  if (selection !== null && previous !== null) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return copied;
}

/**
 * The port as this browser supplies it.
 *
 * IT IS READ PER CALL, NEVER AT MODULE LOAD. The module is evaluated while the
 * server renders, where there is no `navigator` at all, so a value captured
 * there would say "no clipboard" for the whole session.
 */
export function browserClipboard(): ClipboardPort {
  const writer = globalThis.navigator?.clipboard?.writeText;
  return {
    writeText: writer === undefined ? null : (text: string) => navigator.clipboard.writeText(text),
    copyBySelection,
  };
}

/**
 * Copy one string with whatever this browser offers.
 *
 * @param text What to copy.
 * @returns Whether it landed. Never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  return copyTextWith(text, browserClipboard());
}
