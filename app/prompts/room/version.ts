/**
 * The prompt version stored on every room attempt. Bump it when one of the
 * `v<n>.md` files beside it changes meaning.
 *
 * IT IS ITS OWN MODULE WITH NO IMPORTS, so a route action can take the number
 * without pulling the file reads of `index.ts` into the web server build. See
 * `app/prompts/explain/version.ts`.
 */
export const ROOM_PROMPT_VERSION = 1;
