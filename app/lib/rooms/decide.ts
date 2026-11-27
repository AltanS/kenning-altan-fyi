/**
 * Code decides what a reader sees. The models write and judge, and these pure
 * functions choose.
 *
 * THE RULE IS UNANIMITY, AND SILENCE IS A NO. An item is kept only when BOTH
 * reviewers answered `ok` for its id. An id a reviewer did not mention is
 * dropped, and so is an id a reviewer answered twice with one `reject` among the
 * answers. Nothing is repaired from a reviewer's reason: an item is kept as the
 * writer wrote it, or not at all.
 *
 * NO SERVER IMPORTS, NO CLOCK AND NO RANDOMNESS, so a test reads the whole rule.
 */

import type { LanguageCode } from '#app/lib/dictionary/detect-language';

import { countRoomTerms, type RoomContent, type RoomTerm } from './content';
import { MIN_KEPT_SENTENCES, MIN_KEPT_TERMS } from './limits';
import type { RoomDraft, RoomReview } from './llm-schema';

/** The served languages whose nouns carry a grammatical gender article. English and Turkish have none. */
const LANGUAGES_WITH_GENDER_ARTICLE = {
  en: false,
  de: true,
  tr: false,
  es: true,
} satisfies Record<LanguageCode, boolean>;

/** A model's "nothing here", which may arrive as an empty string, read as `null`. */
function textOrNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * The term with its article said once. A model asked for the two apart still
 * writes "die Sammlung" into `term` now and then, which would read
 * "die die Sammlung" on screen.
 */
function stripLeadingArticle(term: string, article: string | null): string {
  const trimmed = term.trim();
  if (article === null) return trimmed;
  const prefix = `${article.toLowerCase()} `;
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  return trimmed.slice(prefix.length).trim();
}

type DraftTerm = RoomDraft['groups'][number]['terms'][number];

export interface IdentifyDraftParams {
  draft: RoomDraft;
  termLanguage: LanguageCode;
}

/**
 * The draft with a stable id on every item (`t1..`, `s1..`, `r1..`, in document
 * order) and with the articles tidied. This is what the reviewers are shown and
 * what a kept room is made of, so they judge exactly what a reader would read.
 */
export function identifyDraft({ draft, termLanguage }: IdentifyDraftParams): RoomContent {
  const hasArticle = LANGUAGES_WITH_GENDER_ARTICLE[termLanguage];
  let termNumber = 0;

  const identifyTerm = (term: DraftTerm): RoomTerm => {
    termNumber += 1;
    const article = hasArticle ? textOrNull(term.article) : null;
    return {
      ...term,
      id: `t${termNumber}`,
      article,
      term: stripLeadingArticle(term.term, article),
      note: textOrNull(term.note),
    };
  };

  return {
    title: draft.title,
    summary: draft.summary,
    groups: draft.groups.map((group) => ({ name: group.name, terms: group.terms.map(identifyTerm) })),
    sentences: draft.sentences.map((sentence, index) => ({ ...sentence, id: `s${index + 1}` })),
    rules: draft.rules.map((rule, index) => ({
      ...rule,
      id: `r${index + 1}`,
      example: textOrNull(rule.example),
      exampleTranslation: textOrNull(rule.exampleTranslation),
    })),
  };
}

/** An id as a reviewer wrote it, folded to the form it was handed out in. */
function foldId(id: string): string {
  return id.trim().toLowerCase();
}

/** The ids one reviewer accepted: answered `ok` at least once and `reject` never. */
function acceptedIds(review: RoomReview): ReadonlySet<string> {
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  for (const entry of review.verdicts) {
    const target = entry.verdict === 'ok' ? accepted : rejected;
    target.add(foldId(entry.id));
  }
  return new Set([...accepted].filter((id) => !rejected.has(id)));
}

/** What one run keeps. `too-few` is a failed run: there is not enough left to be a room. */
export type RoomDecision =
  | { kind: 'keep'; content: RoomContent; checkedCount: number; removedCount: number }
  | { kind: 'too-few'; keptTerms: number; keptSentences: number; checkedCount: number; removedCount: number };

export interface DecideRoomParams {
  draft: RoomContent;
  languageReview: RoomReview;
  subjectReview: RoomReview;
}

/** How many reviewable items a document holds. */
function countItems(content: RoomContent): number {
  return countRoomTerms(content) + content.sentences.length + content.rules.length;
}

/**
 * Filter the draft down to what both reviewers accepted.
 *
 * A group left with no term is removed. Zero surviving rules is allowed, and the
 * screen hides the section. Fewer than {@link MIN_KEPT_TERMS} terms or
 * {@link MIN_KEPT_SENTENCES} sentences is `too-few`.
 */
export function decideRoom({ draft, languageReview, subjectReview }: DecideRoomParams): RoomDecision {
  const byLanguage = acceptedIds(languageReview);
  const bySubject = acceptedIds(subjectReview);
  const isKept = (item: { id: string }): boolean => byLanguage.has(item.id) && bySubject.has(item.id);

  const content: RoomContent = {
    title: draft.title,
    summary: draft.summary,
    groups: draft.groups
      .map((group) => ({ name: group.name, terms: group.terms.filter(isKept) }))
      .filter((group) => group.terms.length > 0),
    sentences: draft.sentences.filter(isKept),
    rules: draft.rules.filter(isKept),
  };

  const checkedCount = countItems(draft);
  const removedCount = checkedCount - countItems(content);
  const keptTerms = countRoomTerms(content);
  const keptSentences = content.sentences.length;

  if (keptTerms < MIN_KEPT_TERMS || keptSentences < MIN_KEPT_SENTENCES) {
    return { kind: 'too-few', keptTerms, keptSentences, checkedCount, removedCount };
  }
  return { kind: 'keep', content, checkedCount, removedCount };
}
