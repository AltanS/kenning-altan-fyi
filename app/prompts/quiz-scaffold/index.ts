/**
 * The quiz scaffold prompt: the markdown template, and the one function that
 * fills it in.
 *
 * THE TEMPLATE IS READ LAZILY, AND THE READ SURVIVES BUNDLING, for the same
 * two reasons `app/prompts/translation/index.ts` states in full: production
 * runs the bundle in `build/server/`, where `import.meta.url` points, and no
 * markdown is emitted there, so the candidate list falls back to the
 * repo-relative copy `Dockerfile.pnpm` ships; and the read happens inside
 * `renderQuizScaffoldPrompt` rather than at module load, so a module that
 * cannot be imported without touching disk cannot kill a boot.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { PromptFileNotShippedError, substitutePlaceholders } from '#app/prompts/enrichment';

export { QUIZ_SCAFFOLD_PROMPT_VERSION } from './version';

/** Where the markdown sits, relative to the repository root. */
const PROMPT_PATH_FROM_REPO_ROOT = 'app/prompts/quiz-scaffold/v1.md';

/** The template, once it has been read. `null` until the first render. */
let cachedTemplate: string | null = null;

/** Whether the template has already been read into memory. The unit tier's seam. */
export function isQuizScaffoldTemplateLoaded(): boolean {
  return cachedTemplate !== null;
}

/** Every place the template may legitimately live, in the order they are tried. See the file header. */
export function quizScaffoldPromptPathCandidates(): string[] {
  return [fileURLToPath(new URL('./v1.md', import.meta.url)), resolve(process.cwd(), PROMPT_PATH_FROM_REPO_ROOT)];
}

/** The first candidate path that exists. */
function resolvePromptPath(): string {
  const candidates = quizScaffoldPromptPathCandidates();
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
 * `satisfies Record<LanguageCode, string>` so a fifth served language breaks
 * this line at compile time instead of rendering a prompt naming `undefined`.
 */
const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  tr: 'Turkish',
  es: 'Spanish',
} satisfies Record<LanguageCode, string>;

/** Everything the template needs filled in. */
export interface RenderQuizScaffoldPromptParams {
  from: LanguageCode;
  to: LanguageCode;
  /** How many cards to ask for. See `QUIZ_SCAFFOLD_TARGET_COUNT`. */
  count: number;
}

/**
 * Render the quiz scaffold prompt for one language pair.
 *
 * @throws PromptFileNotShippedError when the markdown is on none of the paths
 *   it is expected to be on, which means the image was built without it.
 * @throws UnresolvedPlaceholderError when the template holds a placeholder
 *   this function does not fill, which means the markdown and this file have
 *   drifted.
 */
export function renderQuizScaffoldPrompt(params: RenderQuizScaffoldPromptParams): string {
  return substitutePlaceholders(loadTemplate(), {
    fromLanguageName: LANGUAGE_NAMES[params.from],
    toLanguageName: LANGUAGE_NAMES[params.to],
    count: String(params.count),
  });
}
