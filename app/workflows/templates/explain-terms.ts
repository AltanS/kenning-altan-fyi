/**
 * Explain Terms Workflow Template
 *
 * One stage, one operation: ask the active model to answer one question about
 * words, as a structured document, and write it onto the row that asked for it.
 * Nothing it produces reaches the dictionary.
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { WORKFLOW_TYPES } from '#app/workflows/types';
import { operationHandlers } from '#app/workflows/operations';
import { EXPLAIN_QUEUE } from '#app/lib/translation/limits';

/**
 * Comfortably above `TRANSLATION_TIMEOUT_MS` (90s), with room for the database
 * work on either side of the call. This ceiling exists to catch a hung process,
 * not to cut a slow model off, so it must never be the thing that fires first.
 */
const OPERATION_TIMEOUT_MS = 120_000;

export const explainTermsTemplate: WorkflowTemplateWithHandlers = {
  type: WORKFLOW_TYPES.EXPLAIN_TERMS,
  // ITS OWN QUEUE, unlike the phrase job which shares the word job's. The
  // `stately` policy that makes a singleton key bite at all is set on this queue
  // in `initializeWorkflows`, beside the other two. The reason it is separate is
  // written out on the constant: an explain call is the slowest this app makes,
  // and sharing the translation queue's two workers would hold a reader's
  // single-word translation behind somebody else's explanation.
  queue: EXPLAIN_QUEUE,
  version: '1.0.0',
  description: 'Answer one question about words as a structured explanation',
  estimatedDurationSeconds: 30,
  stages: [
    {
      name: 'explain',
      description: 'Call the active model and write the answer onto its own row',
      operations: [
        {
          type: 'translation.explain-terms',
          handler: operationHandlers.translation.explainTerms,
          timeout: OPERATION_TIMEOUT_MS,
          // ONE ATTEMPT, ON PURPOSE. The operation writes a terminal row on
          // every exit path, so a pg-boss retry would be a SECOND call to a paid
          // provider for a run that has already been reported as finished. A
          // reader who wants another attempt presses the retry button, which is
          // a new row and a new decision.
          maxAttempts: 1,
          critical: true,
        },
      ],
    },
  ],
};
