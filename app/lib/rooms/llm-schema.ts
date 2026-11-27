/**
 * The two shapes a model answers with while a room is built: the draft from the
 * writer, and the verdicts from a reviewer.
 *
 * EVERY FIELD IS REQUIRED, AND AN ABSENT VALUE IS `null`. Structured output in
 * strict mode requires every property, so there is `.nullable()` here and never
 * `.optional()`.
 *
 * EVERY CEILING IS A REFUSAL. An answer past a ceiling fails the parse and the
 * run ends `failed` with a retry offered. A silent trim would report success
 * while showing the reader a different document than the one that was paid for.
 * The ceilings sit well above what the prompt asks for, so only an answer that
 * ignored the prompt reaches them.
 *
 * A LIST CEILING IS CHECKED HERE AND NEVER SENT TO THE PROVIDER. A `.max()` on
 * an array becomes `maxItems` in the JSON schema, and Gemini refuses these two
 * schemas with it ("too many states for serving", a plain 400 through
 * OpenRouter), so no room can be built. `atMost` is a refinement, which has no
 * JSON schema form: the provider never sees it and the parse still refuses.
 *
 * THIS IS NOT THE STORED SHAPE. What a room row holds is `content.ts`, which has
 * no ceilings, so tightening one here never makes a stored room unreadable.
 */

import { z } from 'zod';

/** The most groups, terms, sentences and rules one draft may carry. */
const MAX_GROUPS = 6;
const MAX_TERMS_PER_GROUP = 16;
export const MAX_DRAFT_TERMS = 44;
const MAX_SENTENCES = 16;
const MAX_RULES = 9;

/** The most verdicts one review may carry. Above the largest draft, so a full review always fits. */
const MAX_VERDICTS = 120;

/** A list ceiling that is refused by the parse and absent from the provider's schema. See the file comment. */
function atMost<S extends z.ZodArray>(list: S, ceiling: number): S {
  return list.refine((items) => items.length <= ceiling, { error: `expected at most ${ceiling} items` });
}

const shortText = z.string().min(1).max(120);
const sentenceText = z.string().min(1).max(320);

const draftTerm = z.object({
  /** The word or expression in the term language, in dictionary form, without its article. */
  term: shortText,
  /** The grammatical gender article of a noun, where the language has one. */
  article: z.string().max(20).nullable(),
  partOfSpeech: z.string().min(1).max(60),
  /** In the gloss language. */
  translation: z.string().min(1).max(200),
  /** In the gloss language. */
  note: sentenceText.nullable(),
  /** In the term language. */
  example: sentenceText,
  /** In the gloss language. */
  exampleTranslation: sentenceText,
});

const draftGroup = z.object({
  /** In the gloss language. */
  name: shortText,
  terms: atMost(z.array(draftTerm).min(1), MAX_TERMS_PER_GROUP),
});

const draftSentence = z.object({
  /** In the term language. */
  sentence: sentenceText,
  /** In the gloss language. */
  translation: sentenceText,
  /** In the gloss language: when somebody says this. */
  situation: z.string().min(1).max(240),
});

const draftRule = z.object({
  /** In the gloss language. */
  title: shortText,
  /** In the gloss language. */
  explanation: z.string().min(1).max(900),
  /** In the term language. */
  example: sentenceText.nullable(),
  /** In the gloss language. */
  exampleTranslation: sentenceText.nullable(),
});

/** The one answer shape the writer call accepts. */
export const roomDraftSchema = z
  .object({
    title: shortText,
    summary: z.string().min(1).max(900),
    groups: atMost(z.array(draftGroup).min(1), MAX_GROUPS),
    sentences: atMost(z.array(draftSentence), MAX_SENTENCES),
    rules: atMost(z.array(draftRule), MAX_RULES),
  })
  .superRefine((draft, ctx) => {
    const termCount = draft.groups.reduce((sum, group) => sum + group.terms.length, 0);
    if (termCount <= MAX_DRAFT_TERMS) return;
    ctx.addIssue({
      code: 'custom',
      path: ['groups'],
      message: `expected at most ${MAX_DRAFT_TERMS} terms in total, got ${termCount}`,
    });
  });

export type RoomDraft = z.infer<typeof roomDraftSchema>;

/** What a reviewer says about one item. */
export const ROOM_VERDICTS = ['ok', 'reject'] as const;

/** The one answer shape a reviewer call accepts. */
const reviewVerdict = z.object({
  /** The id the item was shown under: `t3`, `s1`, `r2`. */
  id: z.string().min(1).max(12),
  verdict: z.enum(ROOM_VERDICTS),
  /** Why, in a few words. `null` for an accepted item. */
  reason: z.string().max(600).nullable(),
});

export const roomReviewSchema = z.object({
  verdicts: atMost(z.array(reviewVerdict), MAX_VERDICTS),
});

export type RoomReview = z.infer<typeof roomReviewSchema>;
