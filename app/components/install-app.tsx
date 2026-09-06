import { useState, type ReactElement } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '#app/components/ui/button';
import { useInstallPrompt, type InstallOffer } from '#app/hooks/use-install-prompt';

/**
 * The install card on the settings screen. Renders nothing only for `pending`,
 * the instant before mount when nothing is known yet.
 *
 * A READER WHO CAME TO SETTINGS TO INSTALL THE APP MUST ALWAYS FIND A CONTROL
 * HERE. The card used to render nothing on any browser that never handed the
 * page a `beforeinstallprompt` event, which is every browser but Chromium, and
 * even a Chromium visit could lose the event to a slow hydration. That left
 * iOS, Firefox and Samsung Internet readers, and a share of Chrome readers too,
 * looking at an empty section with no way to tell whether installing was even
 * possible.
 *
 * THE FOUR STATES, AND WHY EACH LOOKS LIKE IT DOES.
 *   `ready` gets the primary button: a real `beforeinstallprompt` event is in
 *   hand, so tapping it opens the browser's own install dialog.
 *
 *   `manual` gets a button too, but one that opens written steps instead of a
 *   dialog this browser cannot show. `useInstallPrompt` never claims a browser
 *   simply cannot install; on iOS, Firefox and Samsung Internet it is honest
 *   about the fact that no automated dialog exists here, and the honest control
 *   is one that tells the reader what to tap instead of lying about what it
 *   does.
 *
 *   `installed` gets no button, only the status line: there is nothing left to
 *   offer once the app is already on the device.
 *
 *   `pending` is the only state with no card at all, because it is the server
 *   render and the instant before the detection effect has run. It resolves to
 *   one of the three states above on every real device, so this component's
 *   caller never has to render a heading over an empty body.
 *
 * The detection itself is `useInstallPrompt`, shared with the navigation row,
 * so the card and the row can never disagree about this device.
 */
export function InstallApp(): ReactElement | null {
  const offer = useInstallPrompt();
  return <InstallCard offer={offer} />;
}

/**
 * The card body, split from `InstallApp` so a fixed `offer` can be rendered
 * without going through `useInstallPrompt` and the `window` it reads. See
 * `tests/unit/install-app.test.ts`.
 */
export function InstallCard({ offer }: { offer: InstallOffer }): ReactElement | null {
  const { t } = useTranslation();
  const [stepsOpen, setStepsOpen] = useState(false);

  if (offer.kind === 'pending') return null;

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('settings.installTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('settings.installBody')}</p>
      {offer.kind === 'installed' && <p className="mt-4 text-sm">{t('settings.installedNote')}</p>}
      {offer.kind === 'ready' && (
        <div className="mt-4">
          <Button type="button" onClick={offer.install}>
            <Download className="size-4" aria-hidden="true" />
            {t('settings.installAction')}
          </Button>
        </div>
      )}
      {offer.kind === 'manual' && (
        <div className="mt-4">
          <Button
            type="button"
            aria-expanded={stepsOpen}
            aria-controls="install-manual-steps"
            onClick={() => setStepsOpen((open) => !open)}
          >
            <Download className="size-4" aria-hidden="true" />
            {t('settings.installAction')}
          </Button>
          {stepsOpen && (
            <p id="install-manual-steps" className="mt-4 text-sm">
              {t(manualStepsKey(offer.platform))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The written-steps translation key for a `manual` offer's platform. */
function manualStepsKey(platform: 'ios' | 'android' | 'desktop'): 'settings.installStepsIos' | 'settings.installStepsAndroid' | 'settings.installStepsDesktop' {
  if (platform === 'ios') return 'settings.installStepsIos';
  if (platform === 'android') return 'settings.installStepsAndroid';
  return 'settings.installStepsDesktop';
}
