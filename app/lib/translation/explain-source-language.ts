/**
 * Which language the WORDS on the explain screen are taken to be in, when the
 * stored pair says `detect`.
 *
 * WHY THIS SCREEN CANNOT DETECT. Detection reads the typed text and decides
 * which side of the dictionary it belongs to. On the translator that is exactly
 * right: the typed text IS the word. Here the typed text is a QUESTION, written
 * in the language the reader is comfortable in, about words in another one. A
 * detector pointed at it answers about the question, so `from` would follow the
 * reader's own language and the answer would be about the wrong side.
 *
 * SO THE SOURCE IS STATED, AND THIS IS THE SEED FOR THE STATEMENT. A pair
 * carried over from the translator, or read out of the cookie, can still say
 * `detect`, and the bar on this screen offers no such option: rendered
 * unchanged it would be a select with no matching value, showing an empty
 * trigger and submitting `from=detect`. The reader's UI language is the best
 * guess available without reading their text, and German is the fallback, which
 * is what the language-pair default already says.
 *
 * NO IMPORTS BUT TYPES AND ONE PREDICATE. This is reached by the client bundle.
 */

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { DETECT, isPairLanguage, type SourceSelection } from '#app/lib/dictionary/language-pair';

/** The language-pair module's own default source, repeated here as the last resort. */
const FALLBACK_SOURCE = 'de';

/**
 * @param source What the pair says, `detect` included.
 * @param uiLanguage The reader's interface language, used only when the pair
 *   states nothing.
 * @returns A real language code, always.
 */
export function explainSourceLanguage(source: SourceSelection, uiLanguage: string): LanguageCode {
  if (source !== DETECT) return source;
  return isPairLanguage(uiLanguage) ? uiLanguage : FALLBACK_SOURCE;
}
