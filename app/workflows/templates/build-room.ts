/**
 * Build Room Workflow Template
 *
 * One stage, one operation: write one topic room, have it reviewed twice, and
 * store what survived on the row that asked for it.
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { WORKFLOW_TYPES } from '#app/workflows/types';
import { operationHandlers } from '#app/workflows/operations';
import { ROOM_JOB_EXPIRY_SECONDS, ROOM_OPERATION_TIMEOUT_MS, ROOM_QUEUE } from '#app/lib/rooms/limits';

export const buildRoomTemplate: WorkflowTemplateWithHandlers = {
  type: WORKFLOW_TYPES.BUILD_ROOM,
  // Its own queue with one worker and the `stately` policy, set in
  // `initializeWorkflows`. A build is the longest job this app runs.
  queue: ROOM_QUEUE,
  // NO QUEUE RETRY. A second delivery is a second chance to pay for one attempt,
  // and the reader's retry button is the only retry there is. The expiry sits
  // above the operation timeout: see the chain in `app/lib/rooms/limits.ts`.
  queueConfig: { retryLimit: 0, expireInSeconds: ROOM_JOB_EXPIRY_SECONDS },
  version: '1.0.0',
  description: 'Write one topic room and keep what two reviewers accept',
  estimatedDurationSeconds: 60,
  stages: [
    {
      name: 'build',
      description: 'Write the room, review it twice and store the accepted items',
      operations: [
        {
          type: 'rooms.build-room',
          handler: operationHandlers.rooms.buildRoom,
          timeout: ROOM_OPERATION_TIMEOUT_MS,
          maxAttempts: 1,
          critical: true,
        },
      ],
    },
  ],
};
