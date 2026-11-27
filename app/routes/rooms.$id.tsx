import type { Route } from './+types/rooms.$id';
import { useTranslation } from 'react-i18next';
import { data, type MetaFunction, type ShouldRevalidateFunctionArgs } from 'react-router';
import { ArrowLeft } from 'lucide-react';

import { Link } from '#app/components/link';
import { RoomSections } from '#app/components/rooms/room-sections';
import { RoomProgress, RoomUnbuilt } from '#app/components/rooms/room-status';
import { useRoom, type RoomController } from '#app/components/rooms/use-room';
import { documentTitle, metaLanguage } from '#app/i18n/meta-title';
import { localizedLanguageName } from '#app/lib/rooms/language-names';
import { loadRoomView } from '#app/lib/rooms/service.server';
import type { TitleHandle } from '#app/lib/route-title';
import { resolveUser } from '#app/middleware/auth';
import { getOwnedRoom } from '#app/models/rooms.server';
import { getRawDb } from '#drizzle/db';

export const meta: MetaFunction = ({ matches }) => [
  { title: documentTitle(metaLanguage(matches), 'rooms.metaTitle') },
];

export const handle = { titleKey: 'nav.rooms' } satisfies TitleHandle;

/**
 * A room that is not this reader's is a 404, indistinguishable from one that
 * never existed. Reading a room never starts work.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await resolveUser(request);
  if (user === null) throw data(null, { status: 404 });

  const db = getRawDb();
  const room = await getOwnedRoom(db, { userId: user.id, roomId: params.id });
  if (room === null) throw data(null, { status: 404 });

  return { room: await loadRoomView(db, room) };
}

/** Switching tabs changes the address and nothing the loader reads, so it is not read again. */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  const isTabChange =
    formMethod === undefined && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search;
  return isTabChange ? false : defaultShouldRevalidate;
}

/** What stands under the header, which depends on where the build is. */
function RoomBody({ controller }: { controller: RoomController }) {
  const { t } = useTranslation();
  const { room } = controller;

  if (room.status === 'pending') return <RoomProgress controller={controller} />;
  // An `ok` row whose document no longer decodes has nothing to show.
  if (room.status !== 'ok' || room.content === null) return <RoomUnbuilt controller={controller} />;

  return (
    <>
      <RoomSections
        roomId={room.id}
        content={room.content}
        languages={{ termLanguage: room.termLanguage, glossLanguage: room.glossLanguage }}
        linkableTermIds={room.linkableTermIds}
      />
      <p className="max-w-prose text-xs text-muted-foreground">
        {room.removedCount === null || room.removedCount === 0 ?
          t('rooms.disclaimerPlain')
        : t('rooms.disclaimer', { count: room.removedCount })}
      </p>
    </>
  );
}

export default function RoomRoute({ loaderData }: Route.ComponentProps) {
  const { t, i18n } = useTranslation();
  const controller = useRoom(loaderData.room);
  const { room } = controller;
  const content = room.status === 'ok' ? room.content : null;
  const nameOf = (code: string) => localizedLanguageName({ code, uiLanguage: i18n.language });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          to="/rooms"
          className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground underline underline-offset-4"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('rooms.back')}
        </Link>
        {/* The topic as the reader typed it, the string the list shows. The
            model's own title is not the room's name. */}
        <h2 className="font-display text-xl font-semibold leading-snug tracking-tight break-words sm:text-2xl">
          {room.topic}
        </h2>
        <p className="text-sm text-muted-foreground break-words">
          {t('rooms.pair', { term: nameOf(room.termLanguage), gloss: nameOf(room.glossLanguage) })}
        </p>
        {content !== null && (
          <p lang={room.glossLanguage} className="max-w-prose text-sm">
            {content.summary}
          </p>
        )}
      </header>
      <RoomBody key={room.id} controller={controller} />
    </div>
  );
}
