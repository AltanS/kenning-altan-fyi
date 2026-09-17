/**
 * The shape one model answer must have when it is asked to EXPLAIN words rather
 * than translate them.
 *
 * THE STRUCTURE IS THE FEATURE, AND THAT IS WHY IT IS NOT ONE STRING.
 *   `phraseAnswerSchema` beside this one carries a single field on purpose,
 *   because a translation is one piece of text and any second field would fill
 *   itself up with prose nobody asked for. An explanation is the opposite case:
 *   the reader asked a question whose answer has PARTS, the direct answer, the
 *   words it is about, how they differ, what goes wrong, and what to look up
 *   next. A model handed one free-text field answers all five as a wall of
 *   markdown, and the screen can then only print it. Naming the parts is what
 *   lets the card render an answer, a term list and a comparison table as three
 *   different things, and what lets a missing part be absent rather than faked.
 *
 * EVERY LIST HAS A CEILING, AND EVERY CEILING IS A REFUSAL.
 *   A model that answers with eight terms or a two page answer has ignored the
 *   prompt, and the run ends `failed` with a retry offered rather than an `ok`
 *   row carrying an answer nobody can read on a phone. A silent trim would be
 *   worse: it would report success while showing the reader a different answer
 *   than the one that was paid for.
 *
 * THE CONTRAST TABLE IS CHECKED FOR ALIGNMENT, AND NOTHING ELSE CAN CHECK IT.
 *   `contrasts[].byTerm` is one cell PER TERM, in the order `terms` is in. A
 *   model that returns two cells for three terms produces a table whose rows do
 *   not line up with its header, and there is no way to repair that after the
 *   fact: nobody knows which term the missing cell belonged to. So the parse
 *   refuses it. The same refinement bans a contrast on a one-term answer, which
 *   is a comparison with nothing to compare against.
 *
 * NO SERVER IMPORTS BELONG HERE. The card reads the parsed shape, so this module
 * is reached by the client bundle.
 */

import { z } from 'zod';

/**
 * The registers a term may be marked with.
 *
 * A CLOSED LIST RATHER THAN FREE TEXT, which is the one place this schema is
 * stricter than `translation-schema.ts`. That field is rendered as the model
 * wrote it, beside a word, in the model's own words. This one is rendered as a
 * TRANSLATED pill: the label comes from `explain.register.<key>` in the locale
 * catalogs, so the reader sees their own language. A free string could not be
 * looked up, and a lookup with a fallback to the raw key would quietly print
 * English into a German screen.
 */
export const EXPLAIN_REGISTERS = [
  'neutral',
  'formal',
  'informal',
  'slang',
  'technical',
  'literary',
  'dated',
  'regional',
] as const;

/** One register label, as the card looks it up. */
export type ExplainRegister = (typeof EXPLAIN_REGISTERS)[number];

/**
 * One sentence showing a term in use, with its translation under it.
 *
 * THE TWO FIELDS ARE IN DIFFERENT LANGUAGES, and that is the whole point of the
 * pair: `text` is in the language the words belong to and `translation` is in
 * the language the reader is being answered in. A single field would force the
 * reader to already understand the example they were given to help them.
 */
const example = z.object({
  /** In the source language, and it uses the term it is an example of. */
  text: z.string().min(1).max(200),
  /** The same sentence in the reader's language. */
  translation: z.string().min(1).max(200),
});

/** One word the question is about. */
const term = z.object({
  /** The word as the reader would look it up: source language, dictionary form. */
  term: z.string().min(1).max(60),
  /** One plain sentence in the reader's language. */
  meaning: z.string().min(1).max(200),
  /**
   * How the word is pitched, when that is worth saying.
   *
   * OPTIONAL, for the reason `translations.note` is: most words are ordinary,
   * and a model forced to fill this field would mark half of them `formal`
   * because the field was there. An absent register renders no pill.
   */
  register: z.enum(EXPLAIN_REGISTERS).optional(),
  /** One or two, never more. Three examples of one word is a dictionary page, not an answer. */
  examples: z.array(example).min(1).max(2),
});

/**
 * One place the reader can go and read a proper explanation of this.
 *
 * THE CARD IS AN ANSWER, NOT AN AUTHORITY, AND THIS FIELD IS WHERE IT SAYS SO.
 * Every word above it was written by a model on request, and a reader who wants
 * to check it, or who wants the fuller treatment a card cannot hold, has nowhere
 * to go. Naming the work and the place inside it is the cheapest thing this
 * schema can do about that.
 *
 * `title` AND `locator` ARE REQUIRED AND `url` IS NOT, WHICH IS THE WHOLE POINT
 * OF THE SPLIT. A model knows perfectly well that `wissen` has a Duden entry and
 * that modal verbs are a chapter in Hammer. It does not reliably know the URL of
 * either, and a guessed one is worse than none: a link that 404s reads as a
 * broken product, and a link that resolves to the wrong page reads as a wrong
 * citation the reader will not check. So the prompt asks for a url only when the
 * model is certain, and a reference without one still renders as a usable
 * pointer a person can follow by hand.
 */
const reference = z.object({
  /** The work or the site: "Duden", "DWDS", "Hammer's German Grammar and Usage". */
  title: z.string().min(1).max(80),
  /** Where inside it, in the reader's language: 'entry "wissen"', "chapter 12, modal verbs". */
  locator: z.string().min(1).max(120),
  /** Only when the model is certain the address exists and points at the entry itself. */
  url: z.string().url().max(300).optional(),
});

/** One row of the comparison table: what is being compared, then one cell per term. */
const contrast = z.object({
  /** What this row compares, in the reader's language. "Object", "Tone", "Typical use". */
  aspect: z.string().min(1).max(40),
  /** One cell per term, in the same order as `terms`. The refinement below enforces that. */
  byTerm: z.array(z.string().min(1).max(120)),
});

/** The one answer shape an explain run accepts. */
export const explanationSchema = z
  .object({
    /**
     * The direct answer, one or two sentences, in the reader's language.
     *
     * IT IS THE ONLY REQUIRED PART. Everything under it may legitimately be
     * empty: a question about one word has nothing to contrast, a question about
     * a well-behaved word has no pitfall, and a question that is not about
     * language at all has no terms. This field is where the model says so.
     */
    answer: z.string().min(1).max(500),
    /** Up to three. May be empty when the question names no word this answer could pin down. */
    terms: z.array(term).max(3),
    /** Empty unless there are two or more terms. See the refinement below. */
    contrasts: z.array(contrast).max(4),
    /** Common mistakes, in the reader's language. */
    pitfalls: z.array(z.string().min(1).max(160)).max(3),
    /** Other SOURCE-language words worth looking up. They become links to the translator. */
    related: z.array(z.string().min(1).max(60)).max(4),
    /**
     * Up to three places this is properly explained. See `reference` above.
     *
     * `.default([])` IS LOAD-BEARING AND NOT A CONVENIENCE. Every row written
     * under prompt v1 is stored `jsonb` with no `references` key at all, and
     * `app/models/explanations.server.ts` re-parses that document with THIS
     * schema on every read. A required field here would turn every cached
     * answer this installation has already paid for into a row that "does not
     * decode", which the resolver reads as "nothing is coming" and the trigger
     * half would then queue afresh. The default is what lets an old answer go
     * on being an answer, with no section under it.
     */
    references: z.array(reference).max(3).default([]),
  })
  .superRefine((value, ctx) => {
    // A COMPARISON NEEDS TWO THINGS TO COMPARE. One term with a contrast row is
    // a table with a single column, which is a list wearing a table's clothes,
    // and zero terms with a contrast row is a table about nothing at all.
    if (value.terms.length < 2 && value.contrasts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['contrasts'],
        message: 'contrasts are only meaningful with two or more terms',
      });
      return;
    }
    // EVERY ROW IS AS WIDE AS THE HEADER. A row with the wrong number of cells
    // cannot be repaired afterwards, because nothing says which term a missing
    // cell belonged to, so it is refused here rather than rendered crooked.
    for (const [index, row] of value.contrasts.entries()) {
      if (row.byTerm.length === value.terms.length) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['contrasts', index, 'byTerm'],
        message: `expected one cell per term (${value.terms.length}), got ${row.byTerm.length}`,
      });
    }
  });

/** A parsed explanation, exactly as the card renders it. */
export type Explanation = z.infer<typeof explanationSchema>;

/** One term of a parsed explanation. */
export type ExplanationTerm = Explanation['terms'][number];

/** One row of a parsed explanation's comparison table. */
export type ExplanationContrast = Explanation['contrasts'][number];

/** One place a parsed explanation points the reader at. */
export type ExplanationReference = Explanation['references'][number];
