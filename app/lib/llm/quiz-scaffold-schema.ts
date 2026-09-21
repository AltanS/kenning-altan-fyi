/**
 * The shape one model answer must have when it is asked to scaffold starter
 * vocabulary for a language pair the quiz has too little organic material for.
 *
 * ONE FLAT LIST, NOT A SENSE GRAPH. Unlike `translation-schema.ts`, a scaffold
 * card is not a dictionary edge and carries no sense id: it is a flashcard,
 * word, translation, one optional note, and the model is free to pick the
 * words rather than translate ones the dictionary already offers. See the
 * header of `drizzle/schema/quiz.ts` for why that is its own table.
 *
 * THE CAP LIVES IN THE SCHEMA, for the same reason `MAX_SENSES` does on the
 * translation schema: an over-length answer is a FAILED run, never silently
 * trimmed, so the run row and the rows actually written can never disagree
 * about how many cards were asked for and got written.
 *
 * NO SERVER IMPORTS BELONG HERE. Nothing here reaches the client bundle today
 * (the scaffold has no reader-facing pane to poll), but the same rule the
 * other `#app/lib/llm/*-schema.ts` modules follow costs nothing to keep.
 */

import { z } from 'zod';

/** How many cards one scaffold run may ask for, and the schema's own ceiling. */
export const QUIZ_SCAFFOLD_TARGET_COUNT = 24;

/** One scaffold card, as the model offers it. */
export const quizScaffoldCardSchema = z.object({
  /** The dictionary form, in the SOURCE language. */
  lemma: z.string().min(1).max(80),
  /** The same word, in the TARGET language. */
  translation: z.string().min(1).max(80),
  /** A free-text part of speech label, one or two words. Unlike the dictionary schema this is not constrained to `POS_VALUES`: a scaffold card is never written into `headwords`, so it never has to satisfy that table's natural key. */
  pos: z.string().min(1).max(30).optional(),
  /**
   * One short sentence on when or how the word is used. Optional, for the same
   * reason `translations.note` is (M196): a model forced to fill this in for
   * every one of twenty four words would invent a distinction most of them do
   * not have.
   */
  note: z.string().max(160).optional(),
});

export type QuizScaffoldCandidate = z.infer<typeof quizScaffoldCardSchema>;

/** The whole answer: a flat, capped list of cards. */
export const quizScaffoldAnswerSchema = z.object({
  cards: z.array(quizScaffoldCardSchema).min(1).max(QUIZ_SCAFFOLD_TARGET_COUNT),
});

export type QuizScaffoldAnswer = z.infer<typeof quizScaffoldAnswerSchema>;
