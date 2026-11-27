import type { Route } from './+types/api.rooms.$id.retry';
import { jsonError } from '#app/lib/api-auth.server';
import { loadRoomView, retryRoom } from '#app/lib/rooms/service.server';
import type { RoomRetryResponse } from '#app/lib/rooms/view';
import { authMiddleware } from '#app/middleware/auth';
import { getUser } from '#app/middleware/helpers';
import { getRawDb } from '#drizzle/db';

/**
 * `POST /api/rooms/:id/retry`, another attempt at a room.
 *
 * IT STARTS BILLED WORK, so it needs an account and it passes the same guards a
 * new room does. Only a `failed`, `budget` or stale room starts an attempt, and
 * one conditional update decides it, so two presses start one job.
 */
export const middleware = [authMiddleware];

export async function action({ request, context, params }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  const db = getRawDb();
  const result = await retryRoom(db, { request, userId: getUser(context).id, roomId: params.id });
  if (result.kind === 'not-found') throw jsonError(404, 'not found');

  const body: RoomRetryResponse = { room: await loadRoomView(db, result.room), refusal: result.refusal };
  return Response.json(body);
}
