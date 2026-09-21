/**
 * The prompt version stored on `quiz_scaffold_runs`. Bump it when `v<n>.md`
 * changes meaning.
 *
 * NO IMPORTS, for the same reason `translation/version.ts` has none: a caller
 * that only needs the number should not pull `node:fs` in behind it.
 */
export const QUIZ_SCAFFOLD_PROMPT_VERSION = 1;
