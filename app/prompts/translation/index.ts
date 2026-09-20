/**
 * The translation prompt: the markdown template, and the one function that fills
 * it in.
 *
 * THE TEMPLATE IS READ LAZILY, AND THE READ SURVIVES BUNDLING.
 *   `react-router build` bundles this module into `build/server/index.js`, and
 *   the production server runs THAT BUNDLE, not these sources (ADR-0004). Two
 *   things follow, and both have already broken a boot in this repo.
 *
 *   First, `import.meta.url` MOVES when the module is bundled. It points at
 *   `build/server/`, where no markdown file is ever emitted, so a path resolved
 *   from it alone is correct under `tsx` (the worker) and wrong in production.
 *   The candidate list therefore tries the `import.meta.url` location first and
 *   falls back to the repo-relative copy under `process.cwd()`, which
 *   `Dockerfile.pnpm` genuinely ships.
 *
 *   Second, the read is inside `renderTranslationPrompt` rather than at module
 *   load. A module that cannot be imported without touching the disk is a module
 *   that can kill a boot. Lazily, the same fault is one failed translation.
 *
 *   Nothing cheaper catches this. `tsc`, `oxlint` and the unit tier all run the
 *   UNBUNDLED sources, where `import.meta.url` is right, so all three stay green.
 *
 * THE PLACEHOLDER GUARD IS THE POINT OF THIS MODULE.
 *   Substitution is find-and-replace, and find-and-replace fails silently.
 *   Rename `{{lemma}}` in the markdown and every rendered prompt would carry the
 *   LITERAL text `{{lemma}}` where the word should be. The model would answer,
 *   the answer would parse, and the rows would be about nothing. Nothing else in
 *   the chain can notice that, so the substitution refuses to return a string
 *   that still holds a placeholder. The guard itself lives in the enrichment
 *   prompt module and is imported: one implementation, so the two prompts cannot
 *   drift into two different definitions of "unresolved".
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { MAX_SENSES, MAX_TRANSLATIONS_PER_SENSE } from '#app/lib/translation/limits';
import type { RejectionReason } from '#app/lib/translation/rejection';
import { PromptFileNotShippedError, substitutePlaceholders } from '#app/prompts/enrichment';

export { PROMPT_VERSION } from './version';

/** Where the markdown sits, relative to the repository root. */
const PROMPT_PATH_FROM_REPO_ROOT = 'app/prompts/translation/v3.md';

/** The template, once it has been read. `null` until the first render. */
let cachedTemplate: string | null = null;

/** Whether the template has already been read into memory. The unit tier's seam. */
export function isTemplateLoaded(): boolean {
  return cachedTemplate !== null;
}

/**
 * Every place the template may legitimately live, in the order they are tried.
 *
 * 1. Beside this module, which is correct when the TypeScript sources run under
 *    `tsx`. That is how the worker runs.
 * 2. Under the current working directory, which is correct once this module has
 *    been bundled into `build/server/` and the markdown was left behind.
 */
export function promptPathCandidates(): string[] {
  return [fileURLToPath(new URL('./v3.md', import.meta.url)), resolve(process.cwd(), PROMPT_PATH_FROM_REPO_ROOT)];
}

/** The first candidate path that exists. */
function resolvePromptPath(): string {
  const candidates = promptPathCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new PromptFileNotShippedError(candidates);
  return found;
}

/** The raw template, read on first use and kept. */
function loadTemplate(): string {
  if (cachedTemplate !== null) return cachedTemplate;
  const template = readFileSync(resolvePromptPath(), 'utf8');
  cachedTemplate = template;
  return template;
}

/**
 * The display name of each served language, in English.
 *
 * `satisfies Record<LanguageCode, string>` rather than an annotation, so the map
 * is checked for COMPLETENESS against `LanguageCode`. Adding a fifth served
 * language then breaks this line at compile time instead of rendering a prompt
 * that names an undefined language at runtime.
 */
const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  tr: 'Turkish',
  es: 'Spanish',
} satisfies Record<LanguageCode, string>;

/** What the prompt says when the dictionary records no part of speech. */
const POS_NOT_RECORDED = 'not recorded';

/** One sense the dictionary already holds, as the prompt lists it. */
export interface OfferedSense {
  senseId: string;
  /** Whatever wording the dictionary has for it, in any language. May be empty. */
  glosses: string[];
}

/** Everything the template needs filled in. */
export interface RenderTranslationPromptParams {
  lemma: string;
  /** `null` when the dictionary records no part of speech for this headword. */
  pos: string | null;
  from: LanguageCode;
  to: LanguageCode;
  /**
   * The senses the dictionary already holds, or an empty list.
   *
   * EMPTY IS THE COMMON CASE and it is not an error: about ninety three percent
   * of the German headwords here carry no sense at all, which is the whole
   * reason this feature exists. An empty list switches the prompt into its
   * authoring instruction and the caller into the authoring answer schema.
   */
  senses: OfferedSense[];
  /**
   * What a reader already rejected, when this render is a RE-RUN.
   *
   * `null` or absent is a first run, and the prompt then says the dictionary
   * holds no translation yet. Passing a value changes two things in the
   * template, and they have to change together: the second paragraph stops
   * claiming the gap exists, and a block naming the recorded words is added
   * before the rules. A prompt that told a model the dictionary was empty and
   * then listed what is in it would be asking two questions at once.
   *
   * AN EMPTY `existingLemmas` IS TREATED AS A FIRST RUN, deliberately. The rows
   * can be retracted between the rejection and the job, and a block that lists
   * nothing would ask the model to avoid an empty set while the paragraph above
   * it named a set that is not there. The caller logs that case; here it simply
   * renders the honest prompt.
   */
  revision?: RevisionRequest | null;
}

/** The existing answer a reader rejected, as the re-run prompt states it. */
export interface RevisionRequest {
  /** The target-language words the dictionary already records for this headword. */
  existingLemmas: string[];
  /** Which of the four things the reader said was wrong with that set. */
  reason: RejectionReason;
}

/**
 * The instruction that changes with the two shapes.
 *
 * A lookup keyed on the branch rather than a ternary in the render call, so both
 * wordings sit side by side and neither can be edited without seeing the other.
 */
const TASKS = {
  translateGiven:
    "The senses above are the dictionary's own. Return one object per sense, carrying back its " +
    '`senseId` EXACTLY as it is given above. Do not invent a sense, do not merge two senses, and ' +
    'do not drop one. Do not return a `senseId` that is not in the list.',
  authorSenses:
    'The dictionary holds no senses for this headword yet, so write them. Return one object per ' +
    'distinct meaning, with a `localId` of your own choosing to tell them apart, a `pos`, and a ' +
    '`gloss`: one short line saying what the sense means, written in {{fromLanguageName}}. Give ' +
    'the everyday meanings first and leave out rare or archaic ones.',
} satisfies Record<'translateGiven' | 'authorSenses', string>;

/**
 * What the opening paragraph says about the state of the dictionary.
 *
 * A lookup keyed on the branch rather than a ternary in the render call, for the
 * same reason `TASKS` above is one: both wordings sit side by side and neither
 * can be edited without seeing the other. Here that matters more than it does
 * there, because the two sentences make OPPOSITE factual claims about the same
 * headword, and a prompt that makes the wrong one is how a re-run gets the
 * identical answer back.
 */
const SITUATIONS = {
  firstRun:
    'The dictionary has no translation for it yet, so what you return is written into the ' +
    'dictionary and shown to every later reader.',
  revision:
    'The dictionary already holds the translations listed below. A reader judged them ' +
    'insufficient, so what you return is ADDED to the dictionary beside them and shown to every ' +
    'later reader.',
} satisfies Record<'firstRun' | 'revision', string>;

/**
 * What each rejection code says, in the one sentence the prompt puts it in.
 *
 * `satisfies Record<RejectionReason, string>` rather than an annotation, so a
 * fifth code added to `REJECTION_REASONS` breaks this line at compile time
 * instead of rendering `undefined` into a paid prompt.
 *
 * PLAIN AND SHORT, because this is prompt text and not UI copy. The reader never
 * sees these; the model does, and a sentence hedged for a person reads to a
 * model as uncertainty about the instruction.
 */
const REASON_SENTENCES = {
  missing: 'a word is missing from this set',
  wrong: 'one or more of these words does not mean the headword',
  register: 'the register or the usage note is wrong',
  other: 'the answer is not good enough, without saying which part',
} satisfies Record<RejectionReason, string>;

/**
 * The block the re-run prompt carries, or the empty string on a first run.
 *
 * IT ASKS FOR WHAT IS MISSING, NOT FOR A REWRITE. A plain re-run of the same
 * prompt returns the same words, because nothing about the question changed;
 * telling the model what is already recorded is the only thing that can change
 * the answer. And it says, twice, that returning nothing is a valid answer: a
 * model asked to improve a list that is already correct will otherwise pad it
 * with worse synonyms, and those become permanent dictionary rows.
 *
 * The leading and trailing newlines belong to the block rather than to the
 * template. That is what lets the empty case render a prompt whose shape is
 * exactly v2's: the template holds `{{revision}}` alone on the line between the
 * limits and the rules, so an empty substitution leaves the single blank line
 * that was always there.
 */
function renderRevision(revision: RevisionRequest | null): string {
  if (revision === null) return '';
  const lemmas = revision.existingLemmas.map((lemma) => `- ${lemma}`).join('\n');
  return [
    '',
    '## Already in the dictionary',
    '',
    'The following {{toLanguageName}} words are already recorded for this headword:',
    '',
    lemmas,
    '',
    `A reader judged that set insufficient, and said: ${REASON_SENTENCES[revision.reason]}.`,
    '',
    'Return the renderings that set is MISSING. Do not repeat a word from the list',
    'unless you are correcting its sense assignment, its register or its note. Do not',
    'return a worse synonym merely to return something: if the existing set is in fact',
    'complete and correct, return no translations for that sense at all. A short true',
    'answer is worth more than a padded one.',
    '',
  ].join('\n');
}

/**
 * The senses, as the markdown list the template expects.
 *
 * The sense id is written first and verbatim, because the model has to hand it
 * back on every object it returns. That id is what binds an answer to the row it
 * describes; a rewritten or prettified id would make the answer unattachable.
 */
function renderSenses(senses: OfferedSense[]): string {
  if (senses.length === 0) return 'The dictionary holds no senses for this headword.';
  return senses
    .map((sense) => {
      const glosses = sense.glosses.map((gloss) => `  - ${gloss}`).join('\n');
      const body = glosses === '' ? '  - (no gloss recorded)' : glosses;
      return `- Sense \`${sense.senseId}\`\n${body}`;
    })
    .join('\n');
}

/**
 * Render the translation prompt for one headword.
 *
 * @param params The headword, the direction, and the senses the dictionary
 *   already holds, which may be none.
 * @returns The prompt text to send to the model.
 * @throws PromptFileNotShippedError when the markdown is on none of the paths it
 *   is expected to be on, which means the image was built without it.
 * @throws UnresolvedPlaceholderError when the template holds a placeholder this
 *   function does not fill, which means the markdown and this file have drifted.
 */
export function renderTranslationPrompt(params: RenderTranslationPromptParams): string {
  const fromLanguageName = LANGUAGE_NAMES[params.from];
  const toLanguageName = LANGUAGE_NAMES[params.to];
  const task = params.senses.length === 0 ? TASKS.authorSenses : TASKS.translateGiven;

  // ONE NARROWED VALUE FEEDS BOTH THE PARAGRAPH AND THE BLOCK. Deciding them
  // separately is how the prompt would come to claim the dictionary is empty
  // over a list of what is in it, or the reverse. An empty lemma list collapses
  // to a first run here, which is the only reading that stays true.
  const requested = params.revision ?? null;
  const revision = requested !== null && requested.existingLemmas.length > 0 ? requested : null;

  return substitutePlaceholders(loadTemplate(), {
    lemma: params.lemma,
    pos: params.pos ?? POS_NOT_RECORDED,
    fromLanguageName,
    toLanguageName,
    senses: renderSenses(params.senses),
    situation: revision === null ? SITUATIONS.firstRun : SITUATIONS.revision,
    // The authoring instruction names the source language, so it is substituted
    // before it is substituted INTO the template. Doing it the other way round
    // would leave a `{{fromLanguageName}}` inside the task text, and the guard
    // below would refuse the whole prompt.
    task: task.replaceAll('{{fromLanguageName}}', fromLanguageName),
    // The revision block names the TARGET language, and the same trap applies to
    // it: substituted into the template first, its own `{{toLanguageName}}` would
    // never be reached by the pass that has already run, and the guard would
    // refuse the whole prompt. So it is resolved here, before it goes in.
    revision: renderRevision(revision).replaceAll('{{toLanguageName}}', toLanguageName),
    maxSenses: String(MAX_SENSES),
    maxTranslations: String(MAX_TRANSLATIONS_PER_SENSE),
  });
}
