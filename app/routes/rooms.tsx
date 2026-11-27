import type { Route } from './+types/rooms';
import { useTranslation } from 'react-i18next';
import { data, redirect, type MetaFunction } from 'react-router';
import { z } from 'zod';

import { CREATE_ROOM_INTENT, RoomCreateForm } from '#app/components/rooms/room-create-form';
import { DELETE_ROOM_INTENT, RoomList } from '#app/components/rooms/room-list';
import { usePendingRoomsRefresh } from '#app/components/rooms/use-pending-rooms-refresh';
import { resolveRequestLanguage } from '#app/i18n/language-prefs';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { parseLanguagePairCookie } from '#app/lib/dictionary/language-pair';
import { defaultRoomLanguages, type RoomRefusal } from '#app/lib/rooms/request';
import { createRoom } from '#app/lib/rooms/service.server';
import type { TitleHandle } from '#app/lib/route-title';
import { resolveUser } from '#app/middleware/auth';
import { deleteOwnedRoom, listOwnedRooms } from '#app/models/rooms.server';
import { getRawDb } from '#drizzle/db';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'rooms.metaTitle') },
    { name: 'description', content: metaTitle(language, 'rooms.metaDescription') },
  ];
};

/** The name of this screen, for the chrome's `h1`. */
export const handle = { titleKey: 'nav.rooms' } satisfies TitleHandle;

/**
 * `/rooms`, the form that asks for a topic room and the reader's rooms.
 *
 * THE ROUTE IS UNDER `_app.gated`, so a signed-out request is refused before
 * this runs. `resolveUser` is read for the id, and the null branch is a type
 * narrowing rather than a second gate.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await resolveUser(request);
  if (user === null) throw data(null, { status: 404 });

  const cookieHeader = request.headers.get('cookie');
  const found = await listOwnedRooms(getRawDb(), user.id);
  const defaults = defaultRoomLanguages({
    // The list is newest first.
    newestRoom: found[0] ?? null,
    cookiePair: parseLanguagePairCookie(cookieHeader),
    uiLanguage: resolveRequestLanguage(cookieHeader),
  });

  return {
    defaults,
    rooms: found.map((room) => ({
      id: room.id,
      topic: room.topic,
      termLanguage: room.termLanguage,
      glossLanguage: room.glossLanguage,
      status: room.status,
      createdAt: room.createdAt.getTime(),
    })),
    nowMs: Date.now(),
  };
}

const roomsFormSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal(CREATE_ROOM_INTENT),
    topic: z.string(),
    termLanguage: z.string(),
    glossLanguage: z.string(),
  }),
  z.object({ intent: z.literal(DELETE_ROOM_INTENT), roomId: z.string() }),
]);

/** Every way this action answers without redirecting. */
export type RoomsActionResult =
  | { success: true }
  | { success: false; error: 'unauthenticated' | 'invalid-form' | 'not-found' }
  | { success: false; refusal: RoomRefusal };

/**
 * Asks for a room, or deletes one.
 *
 * A room that is opened, new or already held, redirects to its own page. A
 * delete does not give the day's build count back: the count is a table of its
 * own.
 */
export async function action({ request }: Route.ActionArgs): Promise<RoomsActionResult> {
  const user = await resolveUser(request);
  if (user === null) return { success: false, error: 'unauthenticated' };

  const parsed = roomsFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };
  const form = parsed.data;

  if (form.intent === DELETE_ROOM_INTENT) {
    const deleted = await deleteOwnedRoom(getRawDb(), { userId: user.id, roomId: form.roomId });
    return deleted === null ? { success: false, error: 'not-found' } : { success: true };
  }

  const result = await createRoom(getRawDb(), {
    request,
    userId: user.id,
    topic: form.topic,
    termLanguage: form.termLanguage,
    glossLanguage: form.glossLanguage,
  });
  if (result.kind === 'refused') return { success: false, refusal: result.reason };
  throw redirect(`/rooms/${result.roomId}`);
}

export default function RoomsRoute({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { defaults, rooms, nowMs } = loaderData;
  // The answer object itself, so the form can tell two equal refusals apart.
  const refused = actionData !== undefined && 'refusal' in actionData ? actionData : null;
  usePendingRoomsRefresh(rooms.some((room) => room.status === 'pending'));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <p className="max-w-prose text-sm text-muted-foreground">{t('rooms.intro')}</p>
      <RoomCreateForm defaults={defaults} refused={refused} rooms={rooms} />
      <RoomList rooms={rooms} nowMs={nowMs} />
    </div>
  );
}
