/**
 * The room document as it is stored in `rooms.content` and drawn on screen: the
 * items both reviewers accepted, each under the id it was reviewed with.
 *
 * NO CEILINGS HERE, ON PURPOSE. The column is re-parsed with this schema on
 * every read. A limit added later must not turn an already paid room into a row
 * that does not decode. The limits belong to `llm-schema.ts`, which guards the
 * write.
 *
 * NO SERVER IMPORTS BELONG HERE. The room screen parses the polled body with it.
 */

import { z } from 'zod';

const storedTerm = z.object({
  id: z.string(),
  term: z.string(),
  article: z.string().nullable(),
  partOfSpeech: z.string(),
  translation: z.string(),
  note: z.string().nullable(),
  example: z.string(),
  exampleTranslation: z.string(),
});

const storedGroup = z.object({
  name: z.string(),
  terms: z.array(storedTerm),
});

const storedSentence = z.object({
  id: z.string(),
  sentence: z.string(),
  translation: z.string(),
  situation: z.string(),
});

const storedRule = z.object({
  id: z.string(),
  title: z.string(),
  explanation: z.string(),
  example: z.string().nullable(),
  exampleTranslation: z.string().nullable(),
});

export const roomContentSchema = z.object({
  title: z.string(),
  summary: z.string(),
  groups: z.array(storedGroup),
  sentences: z.array(storedSentence),
  rules: z.array(storedRule),
});

export type RoomContent = z.infer<typeof roomContentSchema>;
export type RoomTerm = z.infer<typeof storedTerm>;
export type RoomGroup = z.infer<typeof storedGroup>;
export type RoomSentence = z.infer<typeof storedSentence>;
export type RoomRule = z.infer<typeof storedRule>;

/** How many terms a room holds across all its groups. */
export function countRoomTerms(content: Pick<RoomContent, 'groups'>): number {
  return content.groups.reduce((sum, group) => sum + group.terms.length, 0);
}
