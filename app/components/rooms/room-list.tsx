import { useTranslation } from 'react-i18next';
import { ExternalLink, Trash2 } from 'lucide-react';

import { ItemActionsMenu } from '#app/components/item-actions-menu';
import { Link } from '#app/components/link';
import { ROOM_STATUS_KEYS } from '#app/components/rooms/room-copy-keys';
import { localizedLanguageName } from '#app/lib/rooms/language-names';
import type { RoomStatus } from '#app/lib/rooms/view';
import { formatRelativeTime } from '#app/lib/relative-time';

/** The intent the delete row posts, which the route action reads. */
export const DELETE_ROOM_INTENT = 'delete';

export interface RoomListEntry {
  id: string;
  topic: string;
  termLanguage: string;
  glossLanguage: string;
  status: RoomStatus;
  createdAt: number;
}

function RoomRow({ room, nowMs }: { room: RoomListEntry; nowMs: number }) {
  const { t, i18n } = useTranslation();
  const href = `/rooms/${room.id}`;
  const nameOf = (code: string) => localizedLanguageName({ code, uiLanguage: i18n.language });

  return (
    <li className="flex items-start gap-2 rounded-lg border bg-card p-2 hover:border-brand-ink/40 hover:bg-primary/5">
      <Link
        to={href}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-md p-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="font-display text-base font-semibold break-words underline underline-offset-4">
          {room.topic}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('rooms.pair', { term: nameOf(room.termLanguage), gloss: nameOf(room.glossLanguage) })}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t(ROOM_STATUS_KEYS[room.status])},{' '}
          <time dateTime={new Date(room.createdAt).toISOString()}>
            {formatRelativeTime(room.createdAt, nowMs, i18n.language)}
          </time>
        </span>
      </Link>
      <ItemActionsMenu
        label={t('rooms.rowActions', { topic: room.topic })}
        actions={[
          { kind: 'link', key: 'open', label: t('rooms.open'), to: href, icon: ExternalLink },
          {
            kind: 'confirm',
            key: 'delete',
            label: t('rooms.delete'),
            destructive: true,
            icon: Trash2,
            title: t('rooms.deleteTitle'),
            description: t('rooms.deleteBody'),
            confirmText: t('rooms.deleteConfirm'),
            confirmPendingText: t('rooms.deletePending'),
            cancelText: t('rooms.deleteCancel'),
            // No toast: the row unmounts with the revalidation that answers the
            // delete, so a success callback here never runs. The row leaving
            // the list is the confirmation.
            formData: { intent: DELETE_ROOM_INTENT, roomId: room.id },
          },
        ]}
      />
    </li>
  );
}

/** The reader's rooms, newest first, or the empty state. Empty is not an error. */
export function RoomList({ rooms, nowMs }: { rooms: RoomListEntry[]; nowMs: number }) {
  const { t } = useTranslation();

  if (rooms.length === 0) {
    return (
      <div className="surface-brand-soft rounded-xl border border-dashed p-6">
        <h2 className="font-display text-base font-semibold">{t('rooms.emptyTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('rooms.emptyBody')}</p>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.11em] text-brand-ink">{t('rooms.listLabel')}</h2>
      <ul className="flex flex-col gap-3">
        {rooms.map((room) => (
          <RoomRow key={room.id} room={room} nowMs={nowMs} />
        ))}
      </ul>
    </section>
  );
}
