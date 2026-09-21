/**
 * Quiz Scaffold Workflow Template
 *
 * One stage, one operation: ask the active model for a batch of starter
 * vocabulary for one language pair, and write it into the shared pool.
 *
 * THE SHARED `default` QUEUE, ON PURPOSE, UNLIKE TRANSLATION/EXPLAIN/
 * ENRICHMENT. Those three each need their own `stately`-policy queue because a
 * pg-boss singleton key only dedupes on a queue whose policy says so
 * (`app/services/workflows.server.ts`). This job needs no pg-boss-level
 * dedupe at all: `claimScaffoldRun` (`app/models/quiz.server.ts`) guarantees
 * at most one job is ever sent per language pair, by way of a database unique
 * constraint checked BEFORE this job is enqueued, not by way of a queue
 * policy checked after. Adding a fourth dedicated queue to the shared
 * orchestrator for a job that fires, at most, once per served language pair
 * for the lifetime of this installation would be ceremony with no reader
 * waiting behind it.
 */
import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { WORKFLOW_TYPES } from '#app/workflows/types';
import { operationHandlers } from '#app/workflows/operations';

export const scaffoldVocabTemplate: WorkflowTemplateWithHandlers = {
  type: WORKFLOW_TYPES.SCAFFOLD_VOCAB,
  queue: 'default',
  version: '1.0.0',
  description: 'Write a batch of starter vocabulary for a language pair into the shared quiz scaffold',
  estimatedDurationSeconds: 20,
  stages: [
    {
      name: 'scaffold',
      description: 'Call the active model and write its cards into quiz_scaffold_cards',
      operations: [
        {
          type: 'quiz.scaffold-vocab',
          handler: operationHandlers.quiz.scaffoldVocab,
          timeout: 90_000,
          // ONE ATTEMPT. The operation writes a terminal run status on every
          // exit path, so a pg-boss retry would be a second paid call for a
          // run already reported as finished.
          maxAttempts: 1,
          critical: true,
        },
      ],
    },
  ],
};
