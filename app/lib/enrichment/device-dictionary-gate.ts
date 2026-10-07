/**
 * device-dictionary-gate.ts, the loader's one decision about the enrichment card
 * behind a device dictionary: may a single-word search queue the explanation job
 * by itself, or does it wait for the reader (M209).
 *
 * IT MIRRORS `app/lib/translation/device-dictionary-gate.ts` (M208), and for the
 * same reason it is a file of its own. The single-word branch of the
 * `translate.tsx` loader cannot be run in a unit test without a database, a
 * session and a language detection round trip, so the choice is taken HERE, over
 * two injected resolvers, and the test drives it with counters.
 *
 * THE COOKIE IS A CLAIM, NOT A PROOF (see `device-dictionary-cookie.ts`). All it
 * can buy is a delay: a read-only panel instead of one that may queue a job. The
 * button that follows posts to `/api/enrichment-request/:headwordId`, which runs
 * the same rate limit and budget guard a page load does, so a reader who writes
 * the cookie by hand spends nothing they could not spend anyway.
 *
 * NO VALUE IMPORT OF A `.server` MODULE. Both resolvers arrive as arguments, and
 * the only import is a type, which is erased before any bundle is built.
 */

import type { EnrichmentPanel } from '#app/lib/enrichment/state.server';

/** The two ways a single-word search can get its enrichment panel. */
export interface WordEnrichmentResolvers {
  /** Whether the explanation waits for the reader. True when the device holds this direction. */
  isDeferred: boolean;
  /**
   * The read-only half: reports the cache and queues nothing. For an entry with
   * senses and nothing cached it answers `pending` EVEN WHEN NOTHING IS QUEUED,
   * which is why {@link resolveWordEnrichmentPanel} maps it.
   */
  read: () => Promise<EnrichmentPanel>;
  /** The half that may queue a billed job. The search path every cookie-less request takes. */
  trigger: () => Promise<EnrichmentPanel>;
}

/**
 * The idle panel that says "nothing is queued, ask when you want it".
 *
 * @param panel A `pending` or `failed` panel from the read-only resolver. Both
 *   carry the model, the language and the cached senses, which this keeps.
 */
function toOnRequestPanel(panel: Extract<EnrichmentPanel, { state: 'pending' | 'failed' }>): EnrichmentPanel {
  return { state: 'idle', reason: 'on-request', model: panel.model, from: panel.from, senses: panel.senses };
}

/**
 * The enrichment panel for a single-word search, read-only when the device
 * dictionary comes first and exactly as before when it does not.
 *
 * NOT DEFERRED IS `trigger()` AND NOTHING ELSE, so with the cookie absent the
 * loader's behaviour is byte-identical to what it was before this gate existed.
 *
 * DEFERRED READS, THEN MAPS TWO STATES, because the read-only half cannot tell
 * "queued" from "not queued":
 *   - `pending` becomes `idle` with reason `on-request`. Returning it as is would
 *     make the screen poll forever and draw skeletons for work that does not
 *     exist (DESIGN.md rule 3).
 *   - `failed` with `retryable` becomes the same idle panel, so the reader can ask
 *     again. A failure that is not yet retryable stays `failed`, exactly as the
 *     trigger half leaves it.
 * `ready` and every `idle` (`not-configured`, `not-requested`) pass through, so a
 * stored explanation still wins and a server with no key still says so.
 *
 * @param resolvers Whether to defer, and the two resolvers to choose between.
 * @returns The panel to put in the loader data.
 */
export async function resolveWordEnrichmentPanel({
  isDeferred,
  read,
  trigger,
}: WordEnrichmentResolvers): Promise<EnrichmentPanel> {
  if (!isDeferred) return trigger();
  const panel = await read();
  if (panel.state === 'pending') return toOnRequestPanel(panel);
  if (panel.state === 'failed' && panel.retryable) return toOnRequestPanel(panel);
  return panel;
}
