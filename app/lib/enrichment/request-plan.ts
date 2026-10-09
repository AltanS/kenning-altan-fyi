/**
 * request-plan.ts, what the enrichment card does while the explanation waits for
 * the reader (M209): draw a neutral block, draw the "Write the explanation"
 * button, or ask by itself, and never more than once per word.
 *
 * THIS IS THE PURE HALF OF `EnrichmentSection`. The repo has no DOM library, so
 * the decision lives here and the tests call it directly, the way
 * `device-dictionary-deferred-pane.test.ts` calls `planDeferredAsk`. In fact it
 * IS `planDeferredAsk`: the rule is the same one the translation pane follows (a
 * device HIT never asks by itself, a MISS asks once, a failed ask falls back to
 * the button), so this file only works out its inputs from a panel and shares the
 * rule instead of copying it.
 *
 * NO VALUE IMPORT OF A `.server` MODULE, and none of the device dictionary
 * engine either: the lookup arrives as a plain status. The section is not on the
 * list of files allowed to import `app/lib/local-dictionary/`, and a status
 * string is all it needs.
 */

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { EnrichmentPanel } from '#app/lib/enrichment/state.server';
import {
  deferredAskKey,
  planDeferredAsk,
  type DeferredAskPlan,
  type DeviceLookupStatus,
} from '#app/lib/translation/pane-state';

/**
 * How the card treats a panel that waits for the reader.
 *
 * `automatic` is every caller that does not defer, the entry page included: the
 * loader there queues by itself and never produces an `on-request` panel.
 * `deferred` is the search screen with a device dictionary for the direction, and
 * it carries where the device lookup stands.
 */
export type EnrichmentOnRequest = { mode: 'automatic' } | { mode: 'deferred'; lookup: DeviceLookupStatus };

/** What {@link planEnrichmentRequest} reads. */
export interface EnrichmentRequestInputs {
  /** The panel on screen: the loader's, or the one a request or a poll replaced it with. */
  panel: EnrichmentPanel;
  headwordId: string;
  /** The language the notes are wanted in. */
  to: LanguageCode;
  onRequest: EnrichmentOnRequest;
  /** The key the card has already asked for automatically, or `null` for none. */
  askedKey: string | null;
  /** Whether a request is in flight right now. */
  isAsking: boolean;
  /** Whether the browser has no connection. Left out it is false. */
  isOffline?: boolean;
}

/**
 * The key an automatic request is remembered by: one word, in one direction.
 *
 * @param key The headword and the two languages.
 * @returns The same key the translation pane uses, so the two cannot drift.
 */
export function enrichmentRequestKey(key: { headwordId: string; from: LanguageCode; to: LanguageCode }): string {
  return deferredAskKey(key);
}

/**
 * Whether this panel is the one that waits for a request.
 *
 * @param panel The panel on screen.
 * @returns True for an idle panel whose reason is `on-request`.
 */
export function isAwaitingEnrichmentRequest(panel: EnrichmentPanel): boolean {
  return panel.state === 'idle' && panel.reason === 'on-request';
}

/**
 * Decide what the enrichment card does for the panel on screen.
 *
 * - `inactive`: the panel is not waiting for a request, so the card renders as it
 *   always did.
 * - `wait`: a neutral empty block. The device lookup is still running, or the one
 *   automatic request is in flight. It must not say anything is being written.
 * - `offer`: the "Write the explanation" button.
 * - `ask-now`: the card posts the request once, from an effect, and renders `wait`.
 * - `offline`: the browser has no connection, so the card draws one calm line and
 *   no button.
 *
 * AN `automatic` CARD NEVER ASKS. It offers the button. An `on-request` panel
 * should not reach one, since only a deferring loader makes it, but if one ever
 * does, a button is the one answer that is neither a dead end nor an unasked
 * spend.
 *
 * @param inputs The panel, the mode and what has already been asked.
 * @returns What to render and whether to ask now.
 */
export function planEnrichmentRequest({
  panel,
  headwordId,
  to,
  onRequest,
  askedKey,
  isAsking,
  isOffline = false,
}: EnrichmentRequestInputs): DeferredAskPlan {
  const from = panel.from;
  return planDeferredAsk({
    isAwaitingAsk: isAwaitingEnrichmentRequest(panel),
    lookup: onRequest.mode === 'deferred' ? onRequest.lookup : 'hit',
    key: from === null ? null : enrichmentRequestKey({ headwordId, from, to }),
    askedKey,
    isAsking,
    isOffline,
  });
}
