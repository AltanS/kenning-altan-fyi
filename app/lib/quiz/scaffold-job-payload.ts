/**
 * What a queued quiz-scaffold job is allowed to say.
 *
 * NO READER IDENTITY, FOR THE SAME REASON THE PHRASE AND EXPLAIN PAYLOADS
 * CARRY NONE. This job is not opened by one reader's request in the way a
 * translation or an explanation is; it is triggered the first time ANY
 * reader's deck for a pair turns out short, and the cards it writes are never
 * attributed to whoever happened to trigger it. There is nothing here for a
 * reader field to describe.
 *
 * `z.strictObject`, so an extra key is a parse error rather than a silently
 * carried field in a JSONB column nobody reads again.
 *
 * NO SERVER IMPORTS BELONG HERE, the same rule `explain-job-payload.ts` states:
 * `#app/workflows/types` needs this shape for the workflow context, and this
 * module must not pull in anything that reaches the database pool.
 */
import { z } from 'zod';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';

export const quizScaffoldJobPayloadSchema = z.strictObject({
  from: z.enum(SERVED_LANGUAGES),
  to: z.enum(SERVED_LANGUAGES),
  /** How many cards to ask the model for. See `QUIZ_SCAFFOLD_TARGET_COUNT`. */
  count: z.number().int().positive(),
});

export type QuizScaffoldJobPayload = z.infer<typeof quizScaffoldJobPayloadSchema>;
