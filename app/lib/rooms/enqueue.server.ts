/**
 * Putting one room build on its queue.
 *
 * THE PAYLOAD IS A ROOM ID AND AN ATTEMPT, parsed here so that nothing else can
 * ride along. See `job-payload.ts`.
 *
 * THE ORCHESTRATOR IMPORT IS DYNAMIC, to cut the module graph edge from a route
 * to the operation handlers and their prompt files. See
 * `app/lib/translation/explain-enqueue.server.ts`.
 */

import { WorkflowError } from '@sprqvntrs/workflows';

import { createComponentLogger } from '#app/lib/logger';
import { WORKFLOW_TYPES } from '#app/workflows/types';

import { roomJobPayloadSchema, roomSingletonKey, type RoomJobPayload } from './job-payload';

const log = createComponentLogger('RoomEnqueue');

/**
 * Queue one build, at most once per room and attempt. A job already queued for
 * that pair counts as done.
 *
 * @throws when no job could be queued: the orchestrator is not initialised, or
 *   the queue refused the job.
 */
export async function enqueueRoomBuild(request: RoomJobPayload): Promise<void> {
  const payload = roomJobPayloadSchema.parse(request);
  const { getOrchestrator } = await import('#app/services/workflows.server');
  try {
    await getOrchestrator().start({
      type: WORKFLOW_TYPES.BUILD_ROOM,
      context: payload,
      singletonKey: roomSingletonKey(payload),
    });
  } catch (cause) {
    // pg-boss answers null for a singleton key that is already queued, and the
    // library turns that into this code.
    if (!(cause instanceof WorkflowError) || cause.code !== 'QUEUE_ERROR') throw cause;
    log.debug('A room build is already queued', { roomId: payload.roomId, attempt: payload.attempt });
  }
}
