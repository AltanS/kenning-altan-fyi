/**
 * One row at the top of the app shell: this page is older than the server, and
 * here is the button that fixes it.
 *
 * ONE STATE, ONE SENTENCE, ONE BUTTON. It says nothing about published
 * releases, because kenning publishes none, and a line about a release feed
 * that does not exist would be a check with no subject. The only thing it can
 * report is the one thing a reader can act on from here.
 *
 * ── HOW IT SITS ─────────────────────────────────────────────────────────────
 *
 * In flow, above the header, so it RESERVES space rather than overlaying it. A
 * banner covering the app header would hide the screen title and the avatar
 * menu at the one moment the reader is being asked to do something. No
 * `fixed`, no `absolute`, no z-index. One line, `truncate`, so the screen below
 * does not reflow under a thumb.
 *
 * ── NO COLOUR-ONLY MEANING, NO MOTION ───────────────────────────────────────
 *
 * The state carries an icon and a sentence, and the tint is decoration on top
 * of both (DESIGN.md section 2). Nothing animates, so `prefers-reduced-motion`
 * has nothing to suppress.
 *
 * The row is an `output` rather than a div carrying `role="status"`: it is the
 * semantic element for a live result, and it announces itself to a screen
 * reader without a redundant role attribute.
 *
 * THERE IS NO DISMISS CONTROL, on purpose. The message is about the page in
 * front of the reader and it is resolved by the button next to it: it goes away
 * by itself the moment they take the reload.
 */
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { useUpdateStatus } from '#app/hooks/use-update-status';
import { Button } from '#app/components/ui/button';

export function UpdateRibbon() {
  const { t } = useTranslation();
  const { ribbon, updateNow } = useUpdateStatus();

  if (ribbon === 'none') return null;

  return (
    <output className="flex min-h-10 w-full shrink-0 items-center gap-2 border-b border-brand-ink/20 bg-primary/10 px-4 text-sm">
      <RefreshCw className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{t('update.bundleReady')}</span>
      <Button type="button" size="sm" variant="outline" className="h-7 shrink-0" onClick={updateNow}>
        {t('update.reload')}
      </Button>
    </output>
  );
}
