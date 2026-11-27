/**
 * The one dictionary read behind a room's links.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT, as in `search.server.ts`.
 */

import { isPairLanguage } from '#app/lib/dictionary/language-pair';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { existingLemmasQuery } from '#app/lib/dictionary/search.server';

import type { RoomContent } from './content';
import { dictionaryLookupKey, selectLinkableTermIds } from './dictionary-links';

export interface FindLinkableTermsParams {
  content: Pick<RoomContent, 'groups'>;
  /** The stored language of the words. A language no longer served links nothing. */
  termLanguage: string;
}

/** The ids of a room's terms that the dictionary holds, asked in one statement. */
export async function findLinkableTermIds(
  db: DictionaryDb,
  { content, termLanguage }: FindLinkableTermsParams,
): Promise<string[]> {
  if (!isPairLanguage(termLanguage)) return [];
  const terms = content.groups.flatMap((group) => group.terms);
  const keys = terms
    .map(({ term }) => dictionaryLookupKey({ term, termLanguage }))
    .filter((key) => key !== null);
  if (keys.length === 0) return [];
  const found = await existingLemmasQuery(db, { normalizedForms: [...new Set(keys)], from: termLanguage });
  const existingKeys = new Set(found.map((row) => row.lemmaNormalized));
  return selectLinkableTermIds({ terms, termLanguage, existingKeys });
}
