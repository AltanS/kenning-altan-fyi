import { useTranslation } from 'react-i18next';
import { ChevronRight, DoorOpen } from 'lucide-react';

import { Link } from '#app/components/link';

/** The compact way to topic rooms, for screens where a reader meets and collects words. */
export function RoomsLinkCard() {
  const { t } = useTranslation();

  return (
    <Link
      to="/rooms"
      className="flex min-h-14 items-center gap-3 rounded-lg border bg-card p-4 outline-none hover:border-brand-ink/40 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <DoorOpen className="size-5 shrink-0 text-brand-ink" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium underline underline-offset-4">{t('rooms.listsCardTitle')}</span>
        <span className="block text-sm text-muted-foreground">{t('rooms.listsCardBody')}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}
