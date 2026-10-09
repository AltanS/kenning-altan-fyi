/**
 * One sentence on the account doors: the lists on this device are still here.
 *
 * WHY IT EXISTS. A reader whose session ended lands on `/sign-in` or `/welcome`,
 * and a sign-in screen with nothing else on it reads like a wall: did signing
 * out delete my lists? It did not. An ended session pauses sync and removes
 * nothing, and this line says so. Only a deliberate sign-out wipes the device,
 * and that clears the signed-in hint too, so this notice is absent afterwards.
 *
 * IT READS THE HINT, which is display-only (`signed-in-hint.ts`). It claims
 * nothing the hint could be wrong about in a way that matters: if the hint
 * is stale, the sentence is a harmless reassurance on a screen that asks the
 * reader to sign in either way.
 *
 * HYDRATION. `useSignedInHint` takes a server snapshot of `null`, so the server
 * render and the first client render both draw nothing, and the sentence
 * appears right after hydration for a device that has a hint.
 */
import { useTranslation } from 'react-i18next';

import { useSignedInHint } from '#app/hooks/use-signed-in-hint';

export function DeviceDataKeptNotice() {
  const { t } = useTranslation();
  const hint = useSignedInHint();

  if (hint === null) return null;

  return <p className="text-sm text-muted-foreground">{t('account.deviceDataKept')}</p>;
}
