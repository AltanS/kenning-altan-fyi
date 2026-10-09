import { useTranslation } from 'react-i18next';
import type { Direction } from '#app/lib/dictionary/detect-language';
import { LANGUAGE_NAMES } from '#app/lib/dictionary/language-pair';
import type { OfflineResultKind, OfflineView } from '#app/lib/offline/offline-view';

/** What {@link OfflineSearchResult} needs. */
export interface OfflineSearchResultProps {
  /** Which screen to draw, from `offlineResultKind`. */
  kind: OfflineResultKind;
  /** The query as typed. */
  q: string;
  /** The direction the search ran in. */
  direction: Direction;
  /** The routing facts the client loader produced. */
  offline: OfflineView;
}

/**
 * The calm screens a search draws when the app server cannot be reached
 * (ADR-0013, offline search).
 *
 * NOTHING HERE IS AN ERROR, AND NOTHING SHOUTS. The reader switched on airplane
 * mode on purpose, or walked into a tunnel, and the app is doing what it was
 * built to do. So each screen is one plain sentence in the muted style the
 * truncation note uses, saying what is true and what to do next. No icon, no
 * red, no "failed".
 *
 * It draws the sentence around a device dictionary hit and never the hit itself:
 * the hit card is `DeviceDictionaryHitCard`, rendered by `SearchPanes`, which is
 * the only screen allowed to hold the entry. This component receives routing
 * facts and a kind, so it cannot show, copy or post a translation even by
 * mistake. It has no button, no form and no link that leaves the page.
 *
 * @param props The screen kind, the typed text, the direction and the routing facts.
 */
export function OfflineSearchResult({ kind, q, direction, offline }: OfflineSearchResultProps) {
  const { t, i18n } = useTranslation();

  if (kind === 'checking') return null;

  if (kind === 'answered') {
    return <p className="text-xs text-muted-foreground">{t('offline.search.answeredNote')}</p>;
  }

  if (kind === 'phrase') {
    return (
      <p role="note" className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        {t('offline.search.phrase')}
      </p>
    );
  }

  if (kind === 'no-dictionary') {
    return (
      <p role="note" className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        {offline.dictionaries.length === 0 ?
          t('offline.search.noDictionaries')
        : t('offline.search.noDictionaryForPair', {
            from: LANGUAGE_NAMES[direction.from],
            to: LANGUAGE_NAMES[direction.to],
          })}
      </p>
    );
  }

  if (kind === 'miss') {
    return (
      <p role="note" className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        {t('offline.search.miss', { query: q })}
      </p>
    );
  }

  return (
    <section className="rounded-lg border bg-muted/40 p-4">
      <h2 className="font-display text-base font-semibold">{t('offline.search.overviewTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {offline.dictionaries.length === 0 ? t('offline.search.noDictionaries') : t('offline.search.overviewBody')}
      </p>
      {offline.dictionaries.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {offline.dictionaries.map((dictionary) => (
            <li key={dictionary.pair} className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-medium">
                {t('settings.deviceDictionary.pairLabel', {
                  from: LANGUAGE_NAMES[dictionary.from],
                  to: LANGUAGE_NAMES[dictionary.to],
                })}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('settings.deviceDictionary.entryWords', {
                  words: new Intl.NumberFormat(i18n.language).format(dictionary.entryCount),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
