/**
 * device-dictionary-gate.ts, the loader's one decision about a device dictionary:
 * may a single-word search queue a paid translation by itself, or does it wait
 * for the reader (M208/03).
 *
 * WHY IT IS A FILE OF ITS OWN. The decision used to be nothing: the single-word
 * branch of the `translate.tsx` loader called `resolveTriggeredTranslationPanel`
 * and that was the end of it. It is now one of two calls, and the loader cannot
 * be run in a unit test without a database, a session and a language detection
 * round trip. So the choice is taken HERE, over two injected resolvers, and the
 * test drives it with counters and, once, with the real resolvers over faked
 * reads.
 *
 * THE COOKIE IS A CLAIM, NOT A PROOF (see `device-dictionary-cookie.ts`). The
 * only thing it can buy is a delay: a read-only panel instead of one that may
 * queue a job. A reader who writes the cookie by hand gets a search that waits for
 * a button, and the button goes through the retry route and its three spend
 * guards, so being lied to costs nothing.
 *
 * NO VALUE IMPORT OF A `.server` MODULE. Both resolvers arrive as arguments, and
 * the only import that is not a type is the cookie reader, which is client- and
 * server-safe.
 */

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { deviceDictionaryPairKey, parseDeviceDictionaryCookie } from '#app/lib/dictionary/device-dictionary-cookie';
import type { TranslationPanel } from '#app/lib/translation/panel.server';

/** What {@link isDeviceDictionaryDirection} needs. */
export interface DeviceDictionaryDirectionOptions {
  /** The request's raw `Cookie` header, or `null`. */
  cookieHeader: string | null;
  /** The language the search ran in. */
  from: LanguageCode;
  /** The language the answer is wanted in. */
  to: LanguageCode;
}

/** The two ways a single-word search can get its translation panel. */
export interface WordPanelResolvers {
  /** Whether the AI translation waits for the reader. True when the device holds this direction. */
  isDeferred: boolean;
  /**
   * The read-only half: reports `ready`, `translating`, `failed`, `budget` or `none`, queues nothing.
   * A `budget` answer is mapped to `none` by {@link resolveWordTranslationPanel}, because a stored
   * budget row would otherwise stick: the budget view has no button.
   */
  read: () => Promise<TranslationPanel>;
  /** The half that may queue a billed job. The search path every cookie-less request takes. */
  trigger: () => Promise<TranslationPanel>;
}

/**
 * Whether the browser says it holds a device dictionary for this direction.
 *
 * SINGLE-WORD BRANCH ONLY. The phrase branch must never call this: a phrase does
 * not use the device dictionary, and reading the cookie there would invite the
 * next change to defer a phrase translation behind a lookup that cannot answer
 * one. `tests/unit/device-dictionary-loader-gate.test.ts` reads the loader's
 * source to keep it that way.
 *
 * @param options The raw cookie header and the direction the search ran in.
 * @returns True when the cookie lists `<from>-<to>`.
 */
export function isDeviceDictionaryDirection({ cookieHeader, from, to }: DeviceDictionaryDirectionOptions): boolean {
  return parseDeviceDictionaryCookie(cookieHeader).has(deviceDictionaryPairKey(from, to));
}

/**
 * The panel for a single-word search, read-only when the device dictionary comes
 * first and exactly as before when it does not.
 *
 * `none` IS THE ANSWER THAT MATTERS. For a pair nobody has translated, the
 * trigger half would queue a job right now. The read half answers `none` and
 * stops, and the screen decides: a device hit offers a button, a device miss
 * asks by itself. A stored `ready` translation wins in both halves.
 *
 * A STORED `budget` ROW IS MAPPED TO `none` WHEN DEFERRED. The read half returns
 * that row as is, and the budget view has no button, so a reader whose word has
 * no device hit would never get the AI answer. The trigger half re-runs the three
 * guards on a `budget` row, and the deferred path must keep that. Reporting
 * `none` sends the Ask button or the automatic ask through the retry route,
 * which re-evaluates the guards: an exhausted budget is refused there and shown
 * as `budget` after the POST. Every other state passes through unchanged.
 *
 * @param resolvers Whether to defer, and the two resolvers to choose between.
 * @returns The panel to put in the loader data.
 */
export function resolveWordTranslationPanel({
  isDeferred,
  read,
  trigger,
}: WordPanelResolvers): Promise<TranslationPanel> {
  if (!isDeferred) return trigger();
  return read().then((panel) => (panel.state === 'budget' ? { state: 'none' } : panel));
}
