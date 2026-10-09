import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  needsHomeScreenAdvice,
  readHomeScreenAdviceInputs,
  readStoragePersisted,
} from '#app/lib/offline/readiness';
import { readOfflineReadiness } from '#app/lib/service-worker';

/** What the card knows about the dictionaries on this device. */
export interface OfflineReadinessProps {
  /**
   * The pair keys of the dictionaries on this device, such as `de-en`. `null`
   * while the device is still being read, or when it cannot be read at all.
   */
  dictionaryPairs: readonly string[] | null;
}

/** What the page reads from the browser once it is on screen. */
interface BrowserFacts {
  controlled: boolean;
  precacheReady: boolean;
  stamp: string | null;
  persisted: boolean | null;
  showHomeScreenAdvice: boolean;
}

/**
 * Whether this device can search with no connection, row by row (ADR-0013).
 *
 * THE CARD ANSWERS ONE QUESTION A READER ASKS BEFORE A FLIGHT: "will it work?"
 * Offline search needs two things on the device, the app's own files and a
 * dictionary, and one thing that keeps them there, the browser's promise not to
 * delete them. Each is a row with a sentence rather than a coloured dot, so the
 * state reads the same to a screen reader and to someone who cannot tell the
 * colours apart.
 *
 * It reads the browser in an effect, never during a render: the server renders
 * this page, and the first paint says nothing about the device rather than
 * guessing. It renders nothing that links, posts or fetches.
 *
 * @param props The dictionaries the settings card has listed.
 */
export function OfflineReadiness({ dictionaryPairs }: OfflineReadinessProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const [facts, setFacts] = useState<BrowserFacts | null>(null);
  // The listing changing means an import or a removal just finished, which is
  // exactly when the storage answer may have changed too.
  const pairCount = dictionaryPairs === null ? null : dictionaryPairs.length;
  const persisted = facts?.persisted ?? null;

  useEffect(() => {
    let ignore = false;
    const load = async (): Promise<void> => {
      const [readiness, storagePersisted] = await Promise.all([readOfflineReadiness(), readStoragePersisted()]);
      const adviceInputs = readHomeScreenAdviceInputs();
      if (ignore) return;
      setFacts({
        ...readiness,
        persisted: storagePersisted,
        showHomeScreenAdvice: adviceInputs !== null && needsHomeScreenAdvice(adviceInputs),
      });
    };
    void load();
    return () => {
      ignore = true;
    };
  }, [pairCount]);

  return (
    <section aria-labelledby={headingId} className="mt-6">
      <h3 id={headingId} className="text-sm font-semibold">
        {t('settings.offlineReadiness.heading')}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.offlineReadiness.body')}</p>
      <dl className="mt-2 divide-y rounded-lg border text-sm">
        <ReadinessRow label={t('settings.offlineReadiness.appLabel')} value={appSentence({ t, facts })} />
        <ReadinessRow
          label={t('settings.offlineReadiness.dictionaryLabel')}
          value={dictionarySentence({ t, dictionaryPairs })}
        />
        {persisted !== null && (
          <ReadinessRow
            label={t('settings.offlineReadiness.storageLabel')}
            value={t(persisted ? 'settings.offlineReadiness.storageKept' : 'settings.offlineReadiness.storageMayGo')}
          />
        )}
      </dl>
      {facts?.showHomeScreenAdvice === true && (
        <p role="note" className="mt-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t('settings.offlineReadiness.iosHomeScreen')}
        </p>
      )}
    </section>
  );
}

/** One label and its sentence. */
function ReadinessRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
      <dt className="font-medium">{label}</dt>
      <dd className="text-muted-foreground">{value}</dd>
    </div>
  );
}

/** The translate function, typed as the sentences need it. */
type Translate = ReturnType<typeof useTranslation>['t'];

/** The app-files sentence for what the worker has recorded. */
function appSentence({ t, facts }: { t: Translate; facts: BrowserFacts | null }): string {
  if (facts === null) return t('settings.offlineReadiness.checking');
  if (!facts.precacheReady) return t('settings.offlineReadiness.appNotReady');
  if (!facts.controlled) return t('settings.offlineReadiness.appReload');
  return t('settings.offlineReadiness.appReady', { stamp: facts.stamp ?? '' });
}

/** The dictionary sentence for what the settings card has listed. */
function dictionarySentence({
  t,
  dictionaryPairs,
}: {
  t: Translate;
  dictionaryPairs: readonly string[] | null;
}): string {
  if (dictionaryPairs === null) return t('settings.offlineReadiness.checking');
  if (dictionaryPairs.length === 0) return t('settings.offlineReadiness.dictionaryNone');
  return t('settings.offlineReadiness.dictionaryReady', { pairs: dictionaryPairs.join(', ') });
}
