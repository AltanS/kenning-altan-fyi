/**
 * One row at the top of the app shell: sync is paused, and here is the way out.
 *
 * It is the sibling of `UpdateRibbon` and copies its idiom on purpose: an
 * `output` (the semantic element for a live result, so no redundant role), a
 * full-width row IN FLOW above the header so it reserves its own space, a bottom
 * hairline, square corners, no left accent border, no animation, no dismiss
 * control, and nothing here ever moves focus. The icon carries meaning beside
 * the sentence and is `aria-hidden`; the tint is decoration on top of both
 * (DESIGN.md section 2).
 *
 * TWO STATES, decided by `resolvePausedRibbon`:
 *
 *   EXPIRED        "Sync is paused. Everything stays on this device." and a link
 *                  to sign in again, back to the screen the reader is on. Online
 *                  only: offline there is no sign-in to do.
 *   OTHER ACCOUNT  "This device holds another account's data. It is not synced."
 *                  and an "Erase it" button behind a confirmation dialog. Shown
 *                  only for a live root answer that names a different account.
 *
 * THERE IS NO DISMISS CONTROL, on purpose. Each message is resolved by the
 * control beside it, and goes away by itself once it is: signing in as the same
 * account clears the pause, and erasing hands the device to the account that is
 * signed in.
 *
 * THE DIALOG IS AN `AlertDialog`, NOT `ConfirmAction`. `ConfirmAction` submits a
 * form to the server through a fetcher, and this erase is entirely on the device
 * (`eraseOtherAccountData`). `device-dictionary-card.tsx` makes the same choice
 * for the same reason. The confirm control is a plain `Button` rather than
 * `AlertDialogAction`, so the dialog stays open while the erase runs and can
 * show the "could not erase" line inside itself.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useRouteLoaderData } from 'react-router';
import { CloudOff } from 'lucide-react';

import { Link } from '#app/components/link';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#app/components/ui/alert-dialog';
import { Button, buttonVariants } from '#app/components/ui/button';
import { useIsOffline } from '#app/hooks/use-is-offline';
import { useSignedInHint } from '#app/hooks/use-signed-in-hint';
import { eraseOtherAccountData } from '#app/lib/sync/erase-other-account';
import { resolvePausedRibbon, signInHref, type PausedRibbonState } from '#app/lib/sync/paused-ribbon-state';
import { cn } from '#app/lib/utils';

/** The row's classes, the same as the update ribbon's. */
const RIBBON_CLASSES =
  'flex min-h-10 w-full shrink-0 items-center gap-2 border-b border-brand-ink/20 bg-primary/10 px-4 text-sm';

/** Where the erase is: not started, running, or refused by a second tab. */
export type ErasePhase = 'idle' | 'erasing' | 'blocked';

export interface SyncPausedRibbonViewProps {
  state: PausedRibbonState;
  /** The `/sign-in?next=` link the expired state offers. */
  signInHref: string;
  /** Where the erase stands. Only the other-account state reads it. */
  erasePhase: ErasePhase;
  /** Runs the erase. Only the other-account state calls it. */
  onErase: () => void;
}

/** What the ribbon draws for a fixed state. It reads no hook but `useTranslation`, so a test can drive it. */
export function SyncPausedRibbonView({ state, signInHref: signInTo, erasePhase, onErase }: SyncPausedRibbonViewProps) {
  const { t } = useTranslation();

  if (state.kind === 'none') return null;

  if (state.kind === 'expired') {
    return (
      <output className={RIBBON_CLASSES}>
        <CloudOff className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{t('sync.pausedExpired')}</span>
        <Link to={signInTo} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 shrink-0')}>
          {t('sync.pausedExpiredAction')}
        </Link>
      </output>
    );
  }

  const isErasing = erasePhase === 'erasing';
  return (
    <output className={RIBBON_CLASSES}>
      <CloudOff className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{t('sync.pausedOtherAccount')}</span>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="h-7 shrink-0">
            {t('sync.eraseOtherAccountAction')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sync.eraseOtherAccountTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('sync.eraseOtherAccountBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {erasePhase === 'blocked' && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {t('sync.eraseOtherAccountBlocked')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isErasing}>{t('sync.eraseOtherAccountCancel')}</AlertDialogCancel>
            <Button type="button" variant="destructive" pending={isErasing} onClick={onErase}>
              {t('sync.eraseOtherAccountConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </output>
  );
}

/** The two root fields this ribbon reads. */
interface RootRibbonData {
  userId: number | null;
  isOfflineFallback: boolean;
}

/** The ribbon wired to the hint, the connectivity flag, the root data and the location. */
export function SyncPausedRibbon() {
  const hint = useSignedInHint();
  const isOnline = !useIsOffline();
  const rootData = useRouteLoaderData<RootRibbonData>('root');
  const { pathname, search } = useLocation();
  const [erasePhase, setErasePhase] = useState<ErasePhase>('idle');

  const state = resolvePausedRibbon({
    hint,
    isOnline,
    rootUserId: rootData?.userId ?? null,
    isOfflineFallback: rootData?.isOfflineFallback ?? false,
  });

  const erase = async (): Promise<void> => {
    if (state.kind !== 'other-account') return;
    setErasePhase('erasing');
    const outcome = await eraseOtherAccountData({ oldUserId: state.hintUserId, newUserId: state.rootUserId });
    if (outcome === 'blocked') {
      setErasePhase('blocked');
      return;
    }
    // A full reload, so the app boots on the empty store and pulls the account
    // that is signed in. The persisters were stopped by the wipe, and starting
    // them again in this page is what the reload is for.
    window.location.reload();
  };

  return (
    <SyncPausedRibbonView
      state={state}
      signInHref={signInHref({ pathname, search })}
      erasePhase={erasePhase}
      onErase={() => void erase()}
    />
  );
}
