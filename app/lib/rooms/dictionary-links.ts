/**
 * Which room terms may link to the translator. PURE.
 *
 * A TERM IS LINKED ONLY WHEN THE SEARCH BEHIND THE LINK IS CERTAIN TO FIND IT.
 * A model writes the terms, and many are trade words the dictionary does not
 * hold. A link on one of those ends on "Nothing matched".
 *
 * A TERM OF SEVERAL WORDS IS NEVER LINKED. The translator sends it down the
 * phrase branch, which looks each word up on its own and never the whole term.
 */

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { normalizeQuery } from '#app/lib/dictionary/normalize';

import type { RoomTerm } from './content';

export interface LookupKeyParams {
  term: string;
  termLanguage: LanguageCode;
}

/** The headword key a search for this term compares with, or null when the term is not one word. */
export function dictionaryLookupKey({ term, termLanguage }: LookupKeyParams): string | null {
  const query = normalizeQuery(term, termLanguage);
  if (query.normalized === '' || query.isPhrase) return null;
  return query.normalized;
}

export interface LinkableTermsParams {
  terms: readonly Pick<RoomTerm, 'id' | 'term'>[];
  termLanguage: LanguageCode;
  /** The lookup keys the dictionary holds in `termLanguage`. */
  existingKeys: ReadonlySet<string>;
}

/** The ids of the terms whose lookup key the dictionary holds. */
export function selectLinkableTermIds({ terms, termLanguage, existingKeys }: LinkableTermsParams): string[] {
  return terms
    .filter(({ term }) => {
      const key = dictionaryLookupKey({ term, termLanguage });
      return key !== null && existingKeys.has(key);
    })
    .map(({ id }) => id);
}
