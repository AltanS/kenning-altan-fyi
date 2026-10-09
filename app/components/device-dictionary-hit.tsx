import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TranslationPane, type TranslationPaneController } from '#app/components/translation-pane';
import { Button } from '#app/components/ui/button';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DeviceDictionaryLookup } from '#app/lib/local-dictionary/use-device-dictionary-hit';
import type { DeferredAskPlan } from '#app/lib/translation/pane-state';

/** The hit the card draws: the lookup narrowed to the one status that carries an entry. */
export type DeviceDictionaryHitLookup = Extract<DeviceDictionaryLookup, { status: 'hit' }>;

/** What {@link DeviceDictionaryHitCard} needs. */
export interface DeviceDictionaryHitCardProps {
  hit: DeviceDictionaryHitLookup;
  /** The language the searched word is written in. */
  from: LanguageCode;
  /** The language of the translations. */
  to: LanguageCode;
}

/**
 * The dictionary on this device answering, above the AI pane (M208/03).
 *
 * IT IS THE SAME CARD THE TRANSLATOR SURFACE ALREADY HAS (DESIGN.md section 3):
 * `rounded-2xl border p-4`, no brand wash, so the box, this card and the AI card
 * read as one column of equals. The first translation is the largest and the rest
 * are a plain list under a hairline, which is the shape the AI card uses for its
 * answer and its alternatives. The words are monospaced because they are the
 * words under examination (DESIGN.md section 4), and each carries its `lang`.
 *
 * THE LAST LINE NAMES WHERE THE DATA CAME FROM, FROM THE META THE LOOKUP RETURNED
 * rather than from a constant here. The licence is share-alike: the credit is the
 * condition of showing the data at all, and a hard-coded string would go on
 * claiming "WikDict" the day another source is imported.
 *
 * THIS COMPONENT IS A DEAD END FOR THE ENTRY. It takes it as a prop and draws it.
 * It writes nothing, posts nothing and offers no copy button or star, because
 * every one of those would carry share-alike text somewhere it is not meant to
 * go: the history log, the favourites snapshot and the synced blob all read the
 * AI pane's rows, and a device hit is not among them.
 */
export function DeviceDictionaryHitCard({ hit, from, to }: DeviceDictionaryHitCardProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const [first, ...rest] = hit.entry.translations;
  if (first === undefined) return null;

  return (
    <section aria-labelledby={labelId} className="rounded-2xl border p-4">
      <p id={labelId} className="text-sm font-medium">
        {t('search.deviceDictionary.label')}
      </p>
      <p lang={from} className="mt-2 font-mono text-sm text-muted-foreground">
        {hit.entry.written}
      </p>
      <p lang={to} className="mt-1 font-mono text-xl">
        {first}
      </p>
      {rest.length > 0 && (
        <ul
          aria-label={t('search.deviceDictionary.otherTranslations')}
          className="mt-3 flex flex-col gap-1 border-t pt-3"
        >
          {rest.map((translation) => (
            <li key={translation} lang={to} className="font-mono text-base">
              {translation}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {t('search.deviceDictionary.source', {
          source: hit.meta.sourceName,
          licence: hit.meta.sourceLicence,
        })}
      </p>
    </section>
  );
}

/** What {@link DeviceDictionaryAnswerBody} needs. */
export interface DeviceDictionaryAnswerBodyProps {
  /** The translation pane's controller, held by the route. */
  controller: TranslationPaneController;
  /** The language of the translations. */
  to: LanguageCode;
  /** What the AI area of a deferred pane does, from `planDeferredAsk`. */
  plan: DeferredAskPlan;
  /** The device lookup, read only for its status. */
  lookup: DeviceDictionaryLookup;
}

/** An empty block that holds the AI area's height and says nothing. */
function NeutralBlock(): ReactNode {
  return <div aria-hidden="true" className="mt-2 h-12" />;
}

/**
 * The body of the AI card: the pane as it always was, or the deferred area.
 *
 * ONE SWITCH, AND THE PANE STAYS FIVE STATES. This chooses between the pane and
 * the areas that stand in for it while nothing has been asked. The pane keeps
 * `ready`, `translating`, `no-entry`, `budget` and `failed`, and the deferred
 * areas are not states of it: they are what the screen draws while the panel is
 * `none`.
 *
 * - `wait`: a neutral empty block. No spinner text, because nothing is
 *   translating. It covers the device lookup running and the automatic ask in
 *   flight.
 * - `offline`: one calm line and no button, because there is no connection.
 * - `offer`: the button. After a hit the sentence says "as well", because the
 *   reader already has an answer. After a miss whose automatic ask did not take
 *   it says only "Ask the AI", because there is nothing to be "as well" as.
 * - A `no-entry` pane while the lookup is still running also shows the neutral
 *   block, so the "no entry" line does not flash and then vanish under a hit.
 *
 * @param props The controller, the language, the plan and the lookup.
 */
export function DeviceDictionaryAnswerBody({ controller, to, plan, lookup }: DeviceDictionaryAnswerBodyProps) {
  const { t } = useTranslation();

  if (plan === 'wait' || plan === 'ask-now') return <NeutralBlock />;
  // NO CONNECTION, SO NO BUTTON. The press would POST to a server that cannot be
  // reached, and the error a fetcher raises replaces the whole screen. One calm
  // line says why the AI is not offered, and the device hit above stays.
  if (plan === 'offline') {
    return <p className="mt-2 text-sm text-muted-foreground">{t('offline.askNeedsConnection')}</p>;
  }
  if (plan === 'offer') {
    return (
      <div className="mt-2">
        <Button type="button" variant="outline" size="sm" pending={controller.isAsking} onClick={controller.ask}>
          {controller.isAsking ?
            t('search.deviceDictionary.askAiPending')
          : t(lookup.status === 'hit' ? 'search.deviceDictionary.askAi' : 'search.deviceDictionary.askAiOnly')}
        </Button>
      </div>
    );
  }
  if (controller.view === 'no-entry' && lookup.status === 'loading') return <NeutralBlock />;
  return <TranslationPane controller={controller} to={to} />;
}
