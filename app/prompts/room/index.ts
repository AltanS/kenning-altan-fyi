/**
 * The three room prompts, one for the writer and one for each reviewer: the
 * markdown templates and the two functions that fill them in.
 *
 * THE TEMPLATES ARE READ LAZILY, AND THE READ SURVIVES BUNDLING, with the same
 * two candidate paths and the same placeholder guard as
 * `app/prompts/explain/index.ts`. That file states why.
 *
 * TEXT A MODEL OR A USER WROTE NEVER FILLS A PLACEHOLDER. The topic and the
 * draft are untrusted, and either may contain `{{something}}`. The guard in
 * `substitutePlaceholders` would read that as an unfilled placeholder and fail
 * the run, so a doubled brace is broken apart before substitution.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { RoomContent } from '#app/lib/rooms/content';
import { PromptFileNotShippedError, substitutePlaceholders } from '#app/prompts/enrichment';

export { ROOM_PROMPT_VERSION } from './version';

/** The two reviewers. Each has its own brief and sees the same draft. */
export const ROOM_REVIEWER_ROLES = ['language', 'subject'] as const;

export type RoomReviewerRole = (typeof ROOM_REVIEWER_ROLES)[number];

/** The markdown file behind each prompt, beside this module. */
const TEMPLATE_FILES = {
  generate: 'generate.v1.md',
  language: 'review-language.v1.md',
  subject: 'review-subject.v1.md',
} satisfies Record<'generate' | RoomReviewerRole, string>;

type TemplateName = keyof typeof TEMPLATE_FILES;

/** The templates already read, so a run reads each file once per process. */
const cachedTemplates = new Map<TemplateName, string>();

/** Every place one template may legitimately live, in the order they are tried. */
export function roomPromptPathCandidates(name: TemplateName): string[] {
  const file = TEMPLATE_FILES[name];
  return [fileURLToPath(new URL(`./${file}`, import.meta.url)), resolve(process.cwd(), 'app/prompts/room', file)];
}

function loadTemplate(name: TemplateName): string {
  const cached = cachedTemplates.get(name);
  if (cached !== undefined) return cached;
  const candidates = roomPromptPathCandidates(name);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new PromptFileNotShippedError(candidates);
  const template = readFileSync(found, 'utf8');
  cachedTemplates.set(name, template);
  return template;
}

/** The display name of each served language, in English. Checked for completeness by `satisfies`. */
const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  tr: 'Turkish',
  es: 'Spanish',
} satisfies Record<LanguageCode, string>;

/** Untrusted text on its way into a template: no doubled brace survives. */
function inert(text: string): string {
  return text.replaceAll('{{', '{ {');
}

export interface RoomPromptParams {
  /** The topic as the reader typed it. */
  topic: string;
  termLanguage: LanguageCode;
  glossLanguage: LanguageCode;
}

function baseValues({ topic, termLanguage, glossLanguage }: RoomPromptParams) {
  return {
    // Quoted and on one line, so the topic cannot close its own tag or start a
    // section of its own.
    topic: inert(JSON.stringify(topic.replaceAll(/\s+/g, ' '))).replaceAll('<', '\\u003c'),
    termLanguageName: LANGUAGE_NAMES[termLanguage],
    glossLanguageName: LANGUAGE_NAMES[glossLanguage],
  };
}

/**
 * The writer's prompt.
 *
 * @throws PromptFileNotShippedError when the markdown was not shipped.
 * @throws UnresolvedPlaceholderError when the markdown and this file have drifted.
 */
export function renderRoomGeneratePrompt(params: RoomPromptParams): string {
  return substitutePlaceholders(loadTemplate('generate'), baseValues(params));
}

export interface RoomReviewPromptParams extends RoomPromptParams {
  role: RoomReviewerRole;
  /** The draft with ids, exactly what a kept room would be made of. */
  draft: RoomContent;
}

/**
 * One reviewer's prompt.
 *
 * @throws PromptFileNotShippedError when the markdown was not shipped.
 * @throws UnresolvedPlaceholderError when the markdown and this file have drifted.
 */
export function renderRoomReviewPrompt({ role, draft, ...params }: RoomReviewPromptParams): string {
  return substitutePlaceholders(loadTemplate(role), {
    ...baseValues(params),
    draft: inert(JSON.stringify(draft, null, 1)).replaceAll('<', '\\u003c'),
  });
}
