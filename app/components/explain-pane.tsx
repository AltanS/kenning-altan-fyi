import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import type { Explanation } from '#app/lib/llm/explain-schema';
import {
  explainPaneEndpoints,
  explainPaneSeedKey,
  explainWaitingKey,
  type ExplainPaneTarget,
} from '#app/lib/translation/explain-pane';
import type { ExplainPanel, TranslationRefusal } from '#app/lib/translation/explain-panel.server';
import {
  initialTranslationPaneState,
  isTranslationPanePolling,
  translationPaneReducer,
  translationPaneView,
  translationPaneWaitPhase,
  TRANSLATION_POLL_INTERVAL_MS,
  type TranslationPaneState,
  type TranslationPaneView,
} from '#app/lib/translation/pane-state';

/**
 * The explain pane's whole behaviour, as a hook.
 *
 * IT IS THE TRANSLATOR'S MACHINE, NOT A SECOND ONE. `translationPaneReducer`,
 * `translationPaneView` and the ninety second stall rule are imported, not
 * copied: the two panes wait on the same kind of run, poll on the same interval,
 * and go stale at the same moment, so two reducers would have been two answers
 * to one question drifting within a milestone. The reducer is generic over the
 * ready payload, which is the one thing that genuinely differs.
 *
 * THE WIRING IS COPIED, AND ONLY THE WIRING. An interval, a fetch, a retry
 * submission. It is the same shape as `useTranslationPane` because it is doing
 * the same job against two different URLs.
 *
 * IT NEVER STARTS WORK. The poll is a GET against a route that cannot enqueue,
 * and the ONE thing here that can spend money is the retry button, which is an
 * explicit press by a signed-in reader against a gated POST.
 */

export interface ExplainPaneController {
  /** The one value the card renders from. */
  view: TranslationPaneView;
  /** The answer, or `null` for every view but `ready`. */
  answer: Explanation | null;
  /** The `explanations` row on screen, or `null`. A report or a retraction would need it. */
  explanationId: string | null;
  /** Which model wrote the answer on screen, or `null`. The disclosure names it. */
  model: string | null;
  /**
   * The score on the answer on screen, and this reader's own vote in it.
   *
   * READ OFF THE HELD PANEL, exactly as `explanationId` and `model` are, so the
   * vote control needs no second fetch of its own: the poll that delivers the
   * answer delivers its tally in the same body. Zero and `null` on every view
   * but `ready`, where there is nothing to score.
   */
  up: number;
  down: number;
  myVote: -1 | 1 | null;
  /**
   * The locale key of the sentence the `translating` view shows.
   *
   * IT PHASES WITH THE ELAPSED WAIT, which is DESIGN.md section 7's rule for a
   * long operation. The PHASE is the shared machine's own
   * (`translationPaneWaitPhase`, over the same `elapsedMs` the stall rule uses),
   * and only the SENTENCE is this screen's: a second timer here would give one
   * run two ideas of how long it had been waiting. The key is a string rather
   * than a rendered sentence, so this hook needs no `t` and stays testable.
   */
  waitingKey: string;
  /** Ask the server to try again. Only ever called from the `failed` view. */
  retry: () => void;
  /** Whether a retry is in flight, so the button can say so and refuse a second press. */
  isRetrying: boolean;
  /**
   * Which guard produced a `budget` view, or `null` on every other view.
   *
   * IT IS READ HERE, FROM THE HELD PANEL, RATHER THAN FROM `pane-state.ts`, for
   * the reason `useTranslationPane` gives: the view collapses the four refusals
   * to one value on purpose, because the card shows one line for all of them,
   * and the reducer has no business knowing which locale key that line is.
   */
  refusalReason: TranslationRefusal | null;
}

export interface UseExplainPaneParams {
  /** The loader's answer. `null` on the landing screen, where nothing was asked. */
  panel: ExplainPanel | null;
  /** The question being answered, or `none`. */
  target: ExplainPaneTarget;
}

/** The panel a screen with nothing to answer renders. */
const NO_ENTRY_PANEL: ExplainPanel = { state: 'no-entry' };

/**
 * The pane's whole behaviour, as a hook, so the route can hold it and the card
 * can stay pure over its props.
 *
 * @param params The loader's panel and what is being asked about.
 * @returns Everything the card and its retry button read.
 */
export function useExplainPane({ panel, target }: UseExplainPaneParams): ExplainPaneController {
  const loaded = panel ?? NO_ENTRY_PANEL;
  const [state, setState] = useState<TranslationPaneState<ExplainPanel>>(() => initialTranslationPaneState(loaded));

  // RE-SEEDING ON A NEW ANSWER, IN RENDER RATHER THAN IN AN EFFECT. A different
  // question arrives as new props on the same component, and an effect that
  // corrected the state afterwards would render one frame of the previous
  // question's answer under the new one. The key deliberately includes the
  // loader panel's STATE and not the panel object, which is a fresh object on
  // every navigation: keying on identity would throw away a poll result the
  // moment anything else on the page re-rendered.
  const seed = `${explainPaneSeedKey(target)}:${loaded.state}`;
  const [seededFrom, setSeededFrom] = useState(seed);
  if (seededFrom !== seed) {
    setSeededFrom(seed);
    setState(initialTranslationPaneState(loaded));
  }

  const endpoints = explainPaneEndpoints(target);
  const isPolling = isTranslationPanePolling<ExplainPanel>(state) && endpoints !== null;
  const pollUrl = endpoints?.poll ?? null;
  const retryUrl = endpoints?.retry ?? null;

  // ONE INTERVAL, NEVER TWO. The effect depends on a BOOLEAN, not on the elapsed
  // count, so a tick does not tear the interval down and start a fresh one,
  // which would reset the three seconds every time and fire nothing. The boolean
  // flips exactly twice, on and off, and the cleanup runs on the off.
  useEffect(() => {
    if (!isPolling || pollUrl === null) return;
    const aborter = new AbortController();

    const timer = setInterval(() => {
      setState((previous) => translationPaneReducer<ExplainPanel>(previous, { type: 'tick' }));
      const ask = async (): Promise<void> => {
        const response = await fetch(pollUrl, { signal: aborter.signal, headers: { accept: 'application/json' } });
        // A NON-2XX IS NOT A STATE TRANSITION. It is "ask again next tick": a
        // proxy hiccup or a restarting server must never be rendered to a reader
        // as a failed explanation, because the run behind it may be running
        // perfectly well.
        if (!response.ok) throw new Error(`explain poll answered ${response.status}`);
        // SAFETY: the body is whatever `routes/api.explain.ts` serialised, which
        // is an `ExplainPanel` on both of its paths, including the unreadable
        // query exit. The reducer reads one field, `state`, and refuses anything
        // that is not one of the three terminal values, so a body that somehow
        // did not come from that route changes nothing rather than rendering a
        // state the card cannot draw. The card then reads `answer` only inside
        // the `ready` view, whose document the server parsed before storing it.
        const polled = (await response.json()) as ExplainPanel;
        setState((previous) => translationPaneReducer<ExplainPanel>(previous, { type: 'polled', panel: polled }));
      };
      void ask().catch(() => {
        setState((previous) => translationPaneReducer<ExplainPanel>(previous, { type: 'poll-failed' }));
      });
    }, TRANSLATION_POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      aborter.abort();
    };
  }, [isPolling, pollUrl]);

  const fetcher = useFetcher<ExplainPanel>();
  const answered = fetcher.data;
  useEffect(() => {
    if (answered === undefined) return;
    setState((previous) => translationPaneReducer<ExplainPanel>(previous, { type: 'adopted', panel: answered }));
  }, [answered]);

  const retry = (): void => {
    if (retryUrl === null) return;
    void fetcher.submit(null, { method: 'post', action: retryUrl });
  };

  const ready = state.panel.state === 'ready' ? state.panel : null;
  const view = translationPaneView<ExplainPanel>(state);

  return {
    view,
    waitingKey: explainWaitingKey(translationPaneWaitPhase<ExplainPanel>(state)),
    answer: ready?.answer ?? null,
    explanationId: ready?.explanationId ?? null,
    model: ready?.model ?? null,
    up: ready?.up ?? 0,
    down: ready?.down ?? 0,
    myVote: ready?.myVote ?? null,
    retry,
    isRetrying: fetcher.state !== 'idle',
    refusalReason: state.panel.state === 'budget' ? state.panel.reason : null,
  };
}
