import type { Route } from './+types/api.rooms.$id';
import { jsonError } from '#app/lib/api-auth.server';
import { loadRoomView } from '#app/lib/rooms/service.server';
import { authMiddleware } from '#app/middleware/auth';
import { getUser } from '#app/middleware/helpers';
import { getOwnedRoom } from '#app/models/rooms.server';
import { getRawDb } from '#drizzle/db';

/**
 * `GET /api/rooms/:id`, where one room stands, as JSON.
 *
 * IT NEVER ENQUEUES. The room page polls it every three seconds while a build is
 * running, so a read that queued work would pay for the same room again and
 * again. The retry POST beside it and the create form are the only places a
 * build starts.
 *
 * Another reader's room id answers 404, exactly like an id that does not exist.
 */
export const middleware = [authMiddleware];

export async function loader({ context, params }: Route.LoaderArgs): Promise<Response> {
  const db = getRawDb();
  const room = await getOwnedRoom(db, { userId: getUser(context).id, roomId: params.id });
  if (room === null) throw jsonError(404, 'not found');
  return Response.json(await loadRoomView(db, room));
}
