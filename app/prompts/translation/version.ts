/**
 * The prompt version stored on every translation run row. Bump it when
 * `v<n>.md` changes meaning.
 *
 * WHY THIS IS ITS OWN MODULE
 *   `index.ts` beside it reads `v3.md` from disk. A route loader needs the
 *   version number to build the job payload and the singleton key, and nothing
 *   else, so importing it from `index.ts` would pull a synchronous file read, and
 *   `node:fs`, into the React Router server build for the sake of one integer.
 *   This file has no imports at all, so a loader can take the number and leave
 *   the file system behind.
 *
 * IT IS ALSO PART OF THE DEDUPE KEY. Bumping it is how a reworded prompt gets a
 * second chance at a headword an earlier version already answered for.
 *
 * WHY IT IS 3, AND WHY THAT NUMBER IS DOING WORK.
 *   `translationSingletonKey` carries the prompt version, so under version 2 a
 *   headword that version 2 had already been asked about could not be asked
 *   again while that job was live, and `latestRun` for the key would go on
 *   reporting the answer a reader has just rejected. v3 is a different question
 *   in a literal sense: it tells the model what the dictionary already holds and
 *   that somebody judged it insufficient. Bumping the number is therefore not
 *   bookkeeping about a reworded file, it is what makes a re-run reachable at
 *   all.
 */
export const PROMPT_VERSION = 3;
