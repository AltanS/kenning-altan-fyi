import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { TranslationVotes } from '#app/components/translation-votes';
import { Button } from '#app/components/ui/button';
import { Skeleton } from '#app/components/ui/skeleton';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { TranslationPanel, TranslationRefusal, TranslationRow } from '#app/lib/translation/panel.server';
import { REJECTION_REASONS, type RejectionReason } from '#app/lib/translation/rejection';
import type { RejectOutcome, RejectRerun } from '#app/routes/api.translation.$headwordId.reject';
import {
  initialTranslationPaneState,
  isTranslationPanePolling,
  translationPaneAllText,
  translationPaneAlternatives,
  translationPanePrimary,
  translationPaneReducer,
  translationPaneRows,
  translationPaneText,
  translationPaneView,
  translationPaneWaitPhase,
  translationPaneEndpoints,
  translationPaneSeedKey,
  TRANSLATION_POLL_INTERVAL_MS,
  type TranslationPaneState,
  type TranslationPaneTarget,
  type TranslationPaneView,
  type TranslationWaitPhase,
} from '#app/lib/translation/pane-state';

/**
 * What the search pane says about the translation of the word that was typed.
 *
 * ONE STATE MACHINE, ONE STATE VALUE (M193, counsel adjustment J). Every branch
 * below is reached from `translationPaneView`, a single value, and there is no
 * second flag beside it. The inline `EnrichmentSection` under this pane is a
 * different component with its own state, and the two never share a value even
 * though both poll.
 *
 * THE STATE MACHINE ITSELF IS NOT IN THIS FILE. It is four pure transitions in
 * `#app/lib/translation/pane-state`, so it can be tested without a DOM. What is
 * here is the wiring: an interval, a fetch, a retry submission, and the markup.
 *
 * IT NEVER STARTS WORK. The poll is a GET against a route that cannot enqueue,
 * and the ONE thing here that can spend money is the retry button, which is an
 * explicit press by a signed-in reader against a gated POST.
 *
 * NAVIGATING AWAY AND BACK RESUMES FROM THE LOADER. There is no client memory of
 * "I was polling this": a new search re-seeds this pane from the loader's panel,
 * which reports whatever the run actually did while the reader was away.
 */

/** The house recipe for a quiet line inside the answer card. */
const QUIET_LINE = 'text-sm text-muted-foreground';

/**
 * The four reason codes, each as the locale key of its button.
 *
 * A TABLE OVER THE TUPLE, for the reason `REFUSAL_KEYS` further down is one:
 * `satisfies Record<RejectionReason, string>` checks the keys against the union
 * without widening the values, so a fifth code added to `REJECTION_REASONS`
 * fails the typecheck here rather than rendering a button with no words on it.
 */
export const REJECTION_REASON_KEYS = {
  missing: 'translation.reasonMissing',
  wrong: 'translation.reasonWrong',
  register: 'translation.reasonRegister',
  other: 'translation.reasonOther',
} satisfies Record<RejectionReason, string>;

/**
 * What each re-run outcome says, or `null` when the pane itself says it.
 *
 * `refused` CARRIES NO SENTENCE ON PURPOSE. The route hands back the refusing
 * panel, which is a `budget` panel, so adopting it moves the pane to its budget
 * branch and that branch already prints the right line, chosen by
 * `translationBudgetKey` from the refusal reason. A sentence here would be a
 * second, less accurate line under the first.
 */
const REJECT_RERUN_KEYS = {
  queued: 'translation.rejectRerunning',
  cooldown: 'translation.rejectCooldown',
  already: 'translation.rejectAlready',
  refused: null,
} satisfies Record<RejectRerun, string | null>;

/** What a settled rejection leaves on screen, and what it hands to the pane. */
export interface RejectResolution {
  /** The one quiet line to print, or `null` when nothing is to be said here. */
  noticeKey: string | null;
  /** The panel the re-run produced, for the pane to adopt, or `null`. */
  panel: TranslationPanel | null;
  /** Whether the control is finished for this answer and must not be offered again. */
  isDone: boolean;
}

/**
 * What became of one rejection, as a pure function over the route's union.
 *
 * PURE, SO THE CHOICE CAN BE ASSERTED WITHOUT A DOM, exactly as
 * `translationBudgetKey` above is. This repo has no DOM library, so a mapping
 * that lived inside the control's JSX could not be tested at all.
 *
 * `isDone` IS WHAT STOPS A SECOND PRESS. A reader who has reported an answer has
 * said their piece: the route records nothing further from them and buys nothing
 * further, and offering the control again would collect a press that does
 * nothing. The two outcomes that are NOT the reader's fault, a refused sign-in
 * and a body the route would not accept, leave it open, because in both cases
 * nothing was recorded and a second attempt can still succeed.
 *
 * @param outcome What the route answered, or `null` when the POST settled with
 *   no body this pane can read. A proxy error page is not a rejection, so it is
 *   reported as a failure the reader can retry rather than as a silent success.
 * @returns The line to print, the panel to adopt and whether the control is spent.
 */
export function rejectResolution(outcome: RejectOutcome | null): RejectResolution {
  if (outcome === null) return { noticeKey: 'translation.rejectFailed', panel: null, isDone: false };
  if (outcome.state === 'unauthenticated') return { noticeKey: outcome.messageKey, panel: null, isDone: false };
  if (outcome.state === 'invalid') return { noticeKey: 'translation.rejectFailed', panel: null, isDone: false };
  if (outcome.state === 'no-run') return { noticeKey: 'translation.rejectNoRun', panel: null, isDone: true };
  return { noticeKey: REJECT_RERUN_KEYS[outcome.rerun], panel: outcome.panel, isDone: true };
}

/** Everything the answer-level rejection control needs, and nothing else. */
export interface TranslationRejectionController {
  /**
   * Whether the control may be shown at all.
   *
   * THREE CONDITIONS, EACH FOR ITS OWN REASON, and the hook is where they are
   * resolved because that is where all three are in scope:
   *   1. THE VIEW IS `ready`. There has to be an answer on screen for a reader
   *      to have an opinion about.
   *   2. THE TARGET HAS A REJECT URL. `translationPaneEndpoints` offers one for
   *      a headword and `null` for a phrase, because a rejection is recorded
   *      against a `translation_runs` row and a sentence has none behind it. The
   *      branch cannot produce a URL, so nobody can set a flag the wrong way.
   *   3. AT LEAST ONE ROW WAS WRITTEN BY A MODEL. An answer built entirely from
   *      imported edges has no model output to reject, and the route would
   *      answer `no-run`. It is read off the rows rather than passed in beside
   *      them, so the button and the route cannot come to disagree.
   * It also goes false once this reader has reported this answer, because a
   * second press records nothing and buys nothing.
   *
   * A SIGNED-OUT READER IS NOT A FOURTH CONDITION. They see the control, press
   * it, and are told to sign in by the route's own locale key. Hiding it would
   * teach them nothing about why it is absent.
   */
  isOffered: boolean;
  /** The one quiet line the control prints, or `null` while it has nothing to say. */
  noticeKey: string | null;
  /** Which reason is in flight, so exactly one button reports itself busy. */
  sending: RejectionReason | null;
  /** Whether any reason is in flight, so the others refuse a second press. */
  isSending: boolean;
  /** Record one reason, and buy the re-run it may buy. */
  send: (reason: RejectionReason) => void;
}

export interface TranslationPaneController {
  /** The one value the pane renders from. */
  view: TranslationPaneView;
  /**
   * Which of the three waiting sentences a `translating` pane is showing.
   *
   * IT IS NOT A SECOND STATE VALUE, and the one-state-value rule above survives
   * it. `view` still decides which branch renders; this only decides which
   * sentence that one branch prints, and it is meaningless on every other
   * branch, where it answers `first` and nothing reads it.
   */
  waitPhase: TranslationWaitPhase;
  /**
   * Every row of the answer, in the order the server sent them. Empty for every
   * view but `ready`.
   *
   * NOTHING RENDERS THIS FLAT ANY MORE, and nothing should. A list of coequal
   * words is a card with no answer on it, which is the defect `primary` and
   * `alternatives` below exist to fix. It is kept because it is the undivided
   * list, and a consumer that needs to count the rows should count them here
   * rather than add one to the alternatives.
   */
  rows: TranslationRow[];
  /**
   * The one row that answers the reader, or `null` when there is no answer yet.
   *
   * IT IS THE ROW EVERY CONSUMER OF THIS PANE ACTS ON. The card renders it at
   * reading size, the copy button copies it, the star saves it and the device
   * history logs it. Before this existed the card drew three coequal words and
   * all three of those consumers took every one of them, so a reader who had
   * decided which word was right still copied and kept the other two.
   */
  primary: TranslationRow | null;
  /**
   * The rows that are not the answer, in the order the server sent them.
   *
   * They are shown, smaller, under the answer, and each one is a tap away from
   * becoming it. The order is `rank.ts`'s and stays `rank.ts`'s: a choice
   * promotes one word and reshuffles nothing.
   */
  alternatives: TranslationRow[];
  /**
   * Make one of the rows the answer.
   *
   * IT WRITES NOTHING AND POSTS NOTHING, and that is the whole design. A vote is
   * a statement about the shared corpus, so it changes what every reader sees;
   * choosing which of three words is MY answer is a view action on this screen
   * and must not be one. Fusing the two would trap the reader either way: they
   * could not pick a word without publicly judging the others, and could not
   * judge one without changing what everybody else is shown. The vote controls
   * beside each row are untouched by this.
   *
   * @param translationId The row to promote. An id that is not in the current
   *   rows leaves the first row as the answer.
   */
  choose: (translationId: string) => void;
  /** The answer as one string, for the copy button above. Empty when there is no answer. */
  text: string;
  /**
   * Every word of the answer, once each, for the copy-all button.
   *
   * IT IS FOR COMPARING, NOT FOR KEEPING. A reader weighing three candidate
   * terms wants all three somewhere they can look at them; nothing is saved or
   * recorded from this string, and `text` above is what the star and the history
   * read.
   */
  allText: string;
  /** Ask the server to try again. Only ever called from the `failed` view. */
  retry: () => void;
  /**
   * The answer-level rejection: whether it may be offered, what it has to say,
   * and how a reason is sent.
   *
   * IT IS HELD BY THE HOOK RATHER THAN BY THE CONTROL, AND THE CARD AROUND THIS
   * PANE IS WHY. `ResultField` in `search-panes.tsx` is keyed on the answer
   * text, so the moment a rejection buys a re-run the answer empties, that card
   * remounts, and every component under it is destroyed. A confirmation held
   * inside the control would be thrown away in the same render that earned it,
   * which is the one sentence this feature exists to show.
   *
   * IT IS NOT A SECOND STATE VALUE. Nothing here decides which of the pane's six
   * views renders. The re-run's panel reaches the machine through the ordinary
   * `adopted` transition, exactly as the retry button's does.
   */
  rejection: TranslationRejectionController;
  /** Whether a retry is in flight, so the button can say so and refuse a second press. */
  isRetrying: boolean;
  /**
   * Which guard produced a `budget` view, or `null` on every other view.
   *
   * IT IS READ HERE, FROM THE HELD PANEL, RATHER THAN FROM `pane-state.ts`.
   * `translationPaneView` collapses the three refusals to one view on purpose,
   * because the pane shows one line for all of them and the reducer has no
   * business knowing which locale key that line is. The rate-limit refusal is
   * the one exception: it is a different sentence, not a different layout, so
   * this field carries just enough of the panel back out for the render below
   * to choose it.
   */
  refusalReason: TranslationRefusal | null;
  /**
   * What this pane is translating, carried out so the render below can tell a
   * dictionary word from a typed sentence.
   *
   * IT IS THE UNION, NOT A BOOLEAN. The one thing that differs between the two
   * branches on screen is the vote control, and the reason it differs is that a
   * phrase answer's `translationId` is a `phrase_translations` row rather than a
   * dictionary edge. A `canVote` flag would carry the conclusion and lose the
   * reason, and the next reader would be free to set it either way.
   */
  target: TranslationPaneTarget;
}

export interface UseTranslationPaneParams {
  /** The loader's answer. `null` on the branches with nothing to translate at all. */
  panel: TranslationPanel | null;
  /**
   * The word or the sentence being translated.
   *
   * ONE HOOK SERVES BOTH BRANCHES, AND THAT IS A PRODUCT RULE (M195/02). A
   * second hook for phrases would be a second set of transitions, a second stall
   * rule and a second idea of what "translating" looks like, and the two would
   * drift within a milestone. The union changes the two URLs and nothing else.
   */
  target: TranslationPaneTarget;
}

/** The panel a branch with nothing to translate renders. */
const NO_ENTRY_PANEL: TranslationPanel = { state: 'no-entry' };

/**
 * The pane's whole behaviour, as a hook, so the card around it can put the copy
 * button on the same answer this pane is showing.
 *
 * WHY THE CONTROLLER IS LIFTED OUT OF THE COMPONENT. The copy button lives in
 * the result card's header, above this pane, and it has to copy the words the
 * pane is CURRENTLY showing, which after a successful poll is not what the
 * loader sent. Reading the answer twice, once for the button and once for the
 * list, is how the two come to disagree.
 */
export function useTranslationPane({ panel, target }: UseTranslationPaneParams): TranslationPaneController {
  const loaded = panel ?? NO_ENTRY_PANEL;
  const [state, setState] = useState<TranslationPaneState>(() => initialTranslationPaneState(loaded));

  // THE READER'S CHOICE, HELD BESIDE THE MACHINE RATHER THAN INSIDE IT, AND THAT
  // DOES NOT BREAK THE ONE-STATE-VALUE RULE ABOVE. `translationPaneView` is
  // still the single switch the pane renders from, and this id decides none of
  // its six values: a chosen row cannot make a `failed` pane `ready`, cannot
  // start or stop a poll, and cannot age the clock. It is read only inside the
  // `ready` view, to say which of that view's rows is the answer. Putting it in
  // `TranslationPaneState` would have made it a second state value the reducer
  // and every transition had to carry, for a thing no transition depends on.
  const [chosenId, setChosenId] = useState<string | null>(null);

  // WHETHER THIS READER HAS POSTED A REJECTION FOR THE ANSWER IN FRONT OF THEM.
  // It is held here rather than in the control for the reason written on
  // `TranslationPaneController.rejection`, and it is what tells "the POST has
  // not happened yet" apart from "the POST settled with nothing readable": the
  // fetcher answers `undefined` for both, and one of them is a failure the
  // reader has to be told about.
  const [hasRejected, setHasRejected] = useState(false);

  // RE-SEEDING ON A NEW ANSWER, IN RENDER RATHER THAN IN AN EFFECT. A search for
  // another word arrives as new props on the same component, and an effect that
  // corrected the state afterwards would render one frame of the previous word's
  // answer under the new word. The key deliberately includes the loader panel's
  // STATE and not the panel object, which is a fresh object on every navigation:
  // keying on identity would throw away a poll result the moment anything else
  // on the page re-rendered.
  //
  // THE CHOICE IS DROPPED HERE TOO, and this is the only place it is dropped. A
  // new answer is a new set of rows, so a chosen id held across it would name a
  // row belonging to the previous word. It rides the existing re-seed rather
  // than an effect of its own for the same reason the state does: an effect
  // would leave one frame of the old choice on the new answer.
  const seed = `${translationPaneSeedKey(target)}:${loaded.state}`;
  const [seededFrom, setSeededFrom] = useState(seed);
  if (seededFrom !== seed) {
    setSeededFrom(seed);
    setState(initialTranslationPaneState(loaded));
    setChosenId(null);
    // THE REJECTION IS DROPPED ON THE SAME RE-SEED, for the same reason the
    // choice is: it was about the previous answer. The fetcher's own data is
    // left where it is and simply stops being read, so a stale confirmation
    // cannot reappear under a word nobody reported.
    setHasRejected(false);
  }

  const endpoints = translationPaneEndpoints(target);
  const isPolling = isTranslationPanePolling(state) && endpoints !== null;
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
      setState((previous) => translationPaneReducer(previous, { type: 'tick' }));
      const ask = async (): Promise<void> => {
        const response = await fetch(pollUrl, { signal: aborter.signal, headers: { accept: 'application/json' } });
        // A NON-2XX IS NOT A STATE TRANSITION. It is "ask again next tick": a
        // proxy hiccup or a restarting server must never be rendered to a reader
        // as a failed translation, because the run behind it may be running
        // perfectly well.
        if (!response.ok) throw new Error(`translation poll answered ${response.status}`);
        // SAFETY: the body is whatever the polled route serialised, which is a
        // `TranslationPanel` on every path through both of them:
        // `routes/api.translation.$headwordId.ts` including its two unknown-id
        // exits, and `routes/api.translation-phrase.ts` including its unreadable
        // query exit. The reducer below reads
        // one field, `state`, and refuses anything that is not one of the three
        // terminal values, so a body that somehow did not come from that route
        // changes nothing rather than rendering a state the pane cannot draw.
        const polled = (await response.json()) as TranslationPanel;
        setState((previous) => translationPaneReducer(previous, { type: 'polled', panel: polled }));
      };
      void ask().catch(() => {
        setState((previous) => translationPaneReducer(previous, { type: 'poll-failed' }));
      });
    }, TRANSLATION_POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      aborter.abort();
    };
  }, [isPolling, pollUrl]);

  const fetcher = useFetcher<TranslationPanel>();
  const answered = fetcher.data;
  useEffect(() => {
    if (answered === undefined) return;
    setState((previous) => translationPaneReducer(previous, { type: 'adopted', panel: answered }));
  }, [answered]);

  // Wrapped rather than handing out `setChosenId` itself: the setter also
  // accepts an updater function, and the controller's contract is one id.
  const choose = (translationId: string): void => {
    setChosenId(translationId);
  };

  const retry = (): void => {
    if (retryUrl === null) return;
    void fetcher.submit(null, { method: 'post', action: retryUrl });
  };

  // THE REJECTION, ON ITS OWN FETCHER. It must not share the retry fetcher: the
  // two post to different routes and answer with different unions, and one
  // fetcher would make each press overwrite the other's answer.
  const rejectFetcher = useFetcher<RejectOutcome>();
  const rejectUrl = endpoints?.reject ?? null;
  const isRejectSettled = hasRejected && rejectFetcher.state === 'idle';
  const rejected = isRejectSettled ? rejectResolution(rejectFetcher.data ?? null) : null;

  // A BOUGHT RE-RUN ENTERS THE MACHINE THROUGH THE ORDINARY `adopted`
  // TRANSITION, so the pane moves to `translating` and the poll loop above takes
  // it from there. The dependency is the fetcher's own panel object, which is
  // the same object until the next answer arrives, so this fires once per
  // rejection rather than once per render.
  const rejectedPanel = rejected?.panel ?? null;
  useEffect(() => {
    if (rejectedPanel === null) return;
    setState((previous) => translationPaneReducer(previous, { type: 'adopted', panel: rejectedPanel }));
  }, [rejectedPanel]);

  const view = translationPaneView(state);
  const rows = translationPaneRows(state);

  // Matched against the tuple rather than read as a raw form value, so the
  // controller hands the render a reason code and never a bare form entry.
  const submittedReason = rejectFetcher.formData?.get('reason') ?? null;
  const sending = REJECTION_REASONS.find((reason) => reason === submittedReason) ?? null;

  // The three conditions and the spent rule, written once. See
  // `TranslationRejectionController.isOffered` for why each one is there.
  const isRejectOffered =
    view === 'ready' && rejectUrl !== null && rows.some((row) => row.generated) && rejected?.isDone !== true;

  const sendRejection = (reason: RejectionReason): void => {
    if (rejectUrl === null) return;
    const body = new FormData();
    body.set('reason', reason);
    setHasRejected(true);
    void rejectFetcher.submit(body, { method: 'post', action: rejectUrl });
  };

  return {
    view,
    waitPhase: translationPaneWaitPhase(state),
    rows,
    primary: translationPanePrimary(state, chosenId),
    alternatives: translationPaneAlternatives(state, chosenId),
    choose,
    text: translationPaneText(state, chosenId),
    allText: translationPaneAllText(state),
    retry,
    rejection: {
      isOffered: isRejectOffered,
      noticeKey: rejected?.noticeKey ?? null,
      sending,
      isSending: rejectFetcher.state !== 'idle',
      send: sendRejection,
    },
    isRetrying: fetcher.state !== 'idle',
    refusalReason: state.panel.state === 'budget' ? state.panel.reason : null,
    target,
  };
}

/**
 * The sentence each refusal renders, as a table over the union.
 *
 * A TABLE RATHER THAN A CHAIN OF COMPARISONS, so a fifth refusal added to
 * `TranslationRefusal` fails the typecheck here instead of silently falling into
 * whatever the last branch said. `satisfies` is what makes that true: it checks
 * the keys against the union without widening the value type, so the lookup
 * below still returns the literal keys.
 *
 * A PURE MAP, so the choice can be asserted without a DOM: this repo has none,
 * and `tests/unit/translation-pane-state.test.ts` calls this function directly
 * rather than rendering the pane to read its text.
 *
 * `rate-limited` says to wait a few minutes, which is true of that guard alone.
 * `too-long` is the phrase path's length cap and says to try a shorter text; it
 * is a refusal rather than a sixth pane state, because the pane's job here is
 * one quiet line and the line is the only thing that differs. `budget` and
 * `daily-cap` both mean nothing more is coming today, so both keep one sentence.
 */
const REFUSAL_KEYS = {
  'rate-limited': 'enrichment.rateLimited',
  budget: 'translation.budget',
  'daily-cap': 'translation.budget',
  'too-long': 'translation.tooLong',
} satisfies Record<TranslationRefusal, string>;

/**
 * The locale key one `budget` view renders.
 *
 * @param reason Which guard produced the refusal, or `null` on a view this
 *   function is never called for.
 */
export function translationBudgetKey(reason: TranslationRefusal | null): string {
  return reason === null ? 'translation.budget' : REFUSAL_KEYS[reason];
}

/**
 * The "Generated" marker, which explains itself.
 *
 * A BARE LABEL IS NOT A DISCLOSURE. A reader meeting the word "Generated" cold
 * has no way to know whether it means "computed", "recent" or "unreliable", so
 * the marker carries the sentence with it: `title` for a pointer, and a press
 * that reveals the same line for a touch screen, which has no hover at all.
 *
 * IT IS EXPORTED, AND `ExplanationCard` IS THE ONLY OTHER CALLER (M198). An
 * explanation is written by a model start to finish, so it carries the same
 * disclosure, and a second copy of it would be a second sentence about the same
 * fact: DESIGN.md section 9 rule 7 says one phrasing per idea.
 */
export function GeneratedMarker() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const hint = t('translation.generatedHint');

  return (
    <>
      <button
        type="button"
        title={hint}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
        // A 44px tap target on a phone and the card's own compact height from
        // `sm` up: this marker sits inline with the word, so a permanent 44px
        // box would push every answer line apart on a desktop card.
        className="inline-flex min-h-11 items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:min-h-0"
      >
        {t('translation.generated')}
      </button>
      {isOpen && <p className={`mt-1 basis-full ${QUIET_LINE}`}>{hint}</p>}
    </>
  );
}

/**
 * One answer: the word, its part of speech, the marker when a model wrote it,
 * whatever judgement control the caller decided belongs beside it, and the
 * model's usage note underneath.
 *
 * THE WORD ITSELF ARRIVES AS A NODE. The answer draws it as a span at reading
 * size and an alternative draws it as a button that promotes it, and those are
 * the only two things that differ between the two rows. Passing the node keeps
 * one row component for both: an `isPrimary` flag here would be a second place
 * deciding what the answer looks like.
 *
 * THE VOTE ALSO ARRIVES AS A NODE RATHER THAN BEING BUILT HERE, and that is what
 * keeps it off a phrase answer by construction. See `TranslationPane` below for
 * where the decision is taken and why it cannot be taken here: this component
 * cannot see which branch it is rendering, and a component that cannot see it
 * cannot get it wrong.
 *
 * THE VOTE IS ON THIS ROW AND NOT ON THE CARD. The reader is looking at several
 * words for one query, and only they know which of them is wrong. A single
 * control over the whole answer would collect a judgement nobody could act on.
 *
 * THE NOTE IS PROSE ABOUT THE WORD, so it is not monospaced and it does not sit
 * on the word's own line: it is one quiet sentence under it saying when this
 * word is used rather than the others, which is the whole reason a card with
 * several candidates on it is readable at all. Most rows carry none.
 */
function TranslationLine({ row, word, votes }: { row: TranslationRow; word: ReactNode; votes: ReactNode }) {
  return (
    <>
      {/* `flex-wrap` with `basis-full` inside is what lets the generated
          marker's revealed sentence take a line of its own on a narrow screen. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {word}
        {row.pos !== null && <span className="text-xs text-muted-foreground">{row.pos}</span>}
        {row.generated && <GeneratedMarker />}
        {votes}
      </div>
      {row.note !== null && <p className={`mt-1 ${QUIET_LINE}`}>{row.note}</p>}
    </>
  );
}

/** The sentence each waiting phase prints, as a table over the union. */
const WAIT_PHASE_KEYS = {
  first: 'translation.translating',
  second: 'translation.translatingStill',
  third: 'translation.translatingLonger',
} satisfies Record<TranslationWaitPhase, string>;

/**
 * What a waiting pane draws: the shape of the answer, and a line that changes
 * as the wait grows.
 *
 * A SKELETON RATHER THAN A SPINNER ALONE (DESIGN.md section 7). Three short
 * bars stand where the word, its part of speech and its note will be, so the
 * card keeps its height and the answer does not shove the page down when it
 * lands. They are `aria-hidden`: a screen reader is told the state by the
 * sentence under them, and three empty boxes announced as content would be
 * noise.
 *
 * THE LINE IS PHASED, AND EVERY PHASE IS TRUE WHEN IT IS SHOWN. One sentence
 * held for most of a minute reads as a frozen screen; a progress bar would be a
 * number this app cannot know. `pane-state.ts` owns the thresholds.
 */
function TranslatingView({ phase }: { phase: TranslationWaitPhase }) {
  const { t } = useTranslation();

  return (
    <div className="mt-2 flex flex-col gap-3">
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-44" />
      </div>
      <p className={QUIET_LINE}>{t(WAIT_PHASE_KEYS[phase])}</p>
    </div>
  );
}

/**
 * The one control that judges the ANSWER rather than a word in it.
 *
 * IT IS NOT A SECOND SET OF THUMBS, AND THAT IS THE WHOLE REASON IT EXISTS. A
 * vote is cast on one dictionary edge, so it can only ever say "this word is
 * right" or "this word is wrong". It cannot say that the answer AS A WHOLE is
 * insufficient, which is the commonest thing actually wrong with one. A reader
 * looking up German `Baumstämme` into Turkish is given `gövde` and `tomruk`.
 * Both are defensible, so no thumbs down belongs on either, and `kütük`, the
 * word they wanted, is missing. Every per-edge control on that card is silent
 * about the only fault the card has.
 *
 * TWO STEPS, NO DIALOG. The first press only reveals the four reasons, so a
 * mis-tap records nothing, and a reason press is the one thing here that can
 * spend money. A modal for four short buttons would take the answer off the
 * screen the reader is judging.
 *
 * THE REASONS ARE TOLD APART BY SHAPE, NEVER BY HUE. Kenning is a mono amber
 * palette (DESIGN.md), so a control coded by colour alone is an invisible
 * control: these are bordered buttons, and the trigger above them is underlined.
 * There is no accent rule down the side of the block either, which DESIGN.md
 * section 10 bans outright.
 *
 * ONLY THE OPEN AND CLOSED STEP IS HELD HERE, the way `GeneratedMarker` holds
 * its own. Everything that outlives the answer, the confirmation and the fact
 * that this reader has reported, is on the controller, because the card around
 * this pane remounts the moment the answer changes.
 */
function TranslationReject({ rejection }: { rejection: TranslationRejectionController }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const { isOffered, noticeKey, sending, isSending } = rejection;

  // Nothing to offer and nothing to say is nothing to draw. It is a guard rather
  // than an empty block, so the pane above keeps its own spacing.
  if (!isOffered && noticeKey === null) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      {noticeKey !== null && <p className={QUIET_LINE}>{t(noticeKey)}</p>}

      {isOffered && !isOpen && (
        <div>
          <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setIsOpen(true)}>
            {t('translation.reportAction')}
          </Button>
        </div>
      )}

      {isOffered && isOpen && (
        <>
          <p className={QUIET_LINE}>{t('translation.reportPrompt')}</p>
          <ul className="flex flex-wrap items-center gap-2">
            {REJECTION_REASONS.map((reason) => (
              <li key={reason}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  // ONE SPINNER, ON THE BUTTON THAT WAS PRESSED. The other three
                  // are disabled and say nothing: four spinners would report four
                  // calls in flight, and there is exactly one.
                  pending={sending === reason}
                  disabled={isSending}
                  onClick={() => rejection.send(reason)}
                >
                  {t(REJECTION_REASON_KEYS[reason])}
                </Button>
              </li>
            ))}
            <li>
              <Button type="button" variant="ghost" size="sm" disabled={isSending} onClick={() => setIsOpen(false)}>
                {t('translation.reportCancel')}
              </Button>
            </li>
          </ul>
        </>
      )}
    </div>
  );
}

export interface TranslationPaneProps {
  controller: TranslationPaneController;
  to: LanguageCode;
}

/**
 * The pane, and under it the one control that judges the whole answer.
 *
 * WHY THE CONTROL IS A SIBLING OF THE BRANCHES RATHER THAN INSIDE THE `ready`
 * ONE. A rejection that buys a re-run moves the pane straight off `ready`, so a
 * control mounted inside that branch would unmount in the same render that its
 * answer arrived, taking the reader's confirmation with it. As a sibling it
 * keeps its place, and its line sits under the waiting skeleton the re-run just
 * produced.
 *
 * WHEN IT IS OFFERED AT ALL is resolved in the hook and read off
 * `controller.rejection`, which carries the three conditions and the reason for
 * each one.
 */
export function TranslationPane({ controller, to }: TranslationPaneProps) {
  return (
    <>
      <TranslationPaneBody controller={controller} to={to} />
      {/* KEYED ON THE POLL URL, which names the word and the direction, so the
          open-or-closed step collapses the moment the pane is looking at
          something else. It is the same key the hook re-seeds its own state on,
          rather than a second idea of when the target changed. */}
      <TranslationReject key={translationPaneSeedKey(controller.target)} rejection={controller.rejection} />
    </>
  );
}

/**
 * The pane itself: one switch over one value.
 *
 * `stalled` IS NOT `failed`, AND THE COPY SAYS SO. The run may still be
 * finishing, so the line asks the reader to come back rather than announcing a
 * failure this screen cannot see. Only a run row that reads failed produces the
 * failure line and the retry button.
 *
 * A PHRASE ANSWER CARRIES NO VOTE CONTROL, AND THE UNION IS WHY.
 *   A vote is cast on a `translations` row, a dictionary edge between two
 *   headwords. A phrase answer has no edge behind it: its `translationId` is a
 *   `phrase_translations` row id, so offering the buttons would post a vote
 *   against an id the votes table has never heard of. The control is therefore
 *   built inside the `headword` branch of `controller.target` and passed down,
 *   which means the phrase branch has no expression that could produce one. It
 *   is not a flag anybody can set the wrong way.
 */
function TranslationPaneBody({ controller, to }: TranslationPaneProps) {
  const { t } = useTranslation();
  const { view, primary, alternatives, target } = controller;

  // The vote control, built inside the `headword` branch of the target and
  // handed to whichever row is being drawn. It is one expression rather than two
  // so the answer and its alternatives cannot end up with different rules about
  // who may vote.
  const votesFor = (row: TranslationRow): ReactNode =>
    target.kind === 'headword' ?
      <TranslationVotes translationId={row.translationId} up={row.up} down={row.down} myVote={row.myVote} />
    : null;

  if (view === 'ready') {
    // A `ready` panel with no rows at all is not something the server produces:
    // the resolver only answers `ready` once it holds at least one row. Drawing
    // nothing is what the empty list here used to draw anyway, so this is a
    // guard rather than a sixth state, and it must not fall through to the
    // no-entry line below, which would tell a reader the word is unknown.
    if (primary === null) return null;
    return (
      <div className="mt-2 flex flex-col gap-4">
        <div>
          <TranslationLine
            row={primary}
            votes={votesFor(primary)}
            word={
              // Monospaced, like every other word under examination on this
              // screen. The part of speech beside it is prose about the word,
              // so it is not.
              <span lang={to} className="font-mono text-xl">
                {primary.lemma}
              </span>
            }
          />
        </div>

        {/* THE ALTERNATIVES, NAMED, UNDER THE ANSWER AND SMALLER THAN IT. They
            used to be three coequal words on one list, which is a card with no
            answer on it: the reader took the first one, a fact about the
            alphabet rather than about the language. A plain top rule separates
            them, never a left border accent, which DESIGN.md section 10 bans.

            TAPPING ONE MAKES IT THE ANSWER, AND POSTS NOTHING. The vote buttons
            sit BESIDE this button and never inside it: a button inside a button
            is invalid markup, and nesting them would let a vote swallow the
            selection press.

            THE ACTION CARRIES A VISIBLE CHIP, NOT ONLY AN `aria-label`. The
            underline alone read as a glossary link, not as "tap to make this
            your answer": a reader upvoted a note-backed alternative expecting
            that to be their choice, and the answer, the copy button, the star
            and the history all stayed on the model's own top pick instead. A
            vote judges the shared corpus (`TranslationVotes` above); this chip
            is the one control that is this reader's own answer, so it has to
            read as a control rather than as styling on the word. */}
        {alternatives.length > 0 && (
          <section className="flex flex-col gap-2 border-t pt-3">
            <h3 className="text-sm font-medium text-muted-foreground">{t('translation.alternatives')}</h3>
            <ul className="flex flex-col gap-2">
              {alternatives.map((row) => (
                <li key={row.translationId}>
                  <TranslationLine
                    row={row}
                    votes={votesFor(row)}
                    word={
                      <button
                        type="button"
                        aria-label={t('translation.useThis')}
                        onClick={() => controller.choose(row.translationId)}
                        className="group inline-flex items-center gap-2"
                      >
                        <span lang={to} className="font-mono text-base underline underline-offset-4 group-hover:no-underline">
                          {row.lemma}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground group-hover:bg-primary/5 group-hover:text-brand-ink">
                          {t('translation.useThisShort')}
                        </span>
                      </button>
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  if (view === 'translating') {
    return <TranslatingView phase={controller.waitPhase} />;
  }

  if (view === 'stalled') {
    return <p className={`mt-2 ${QUIET_LINE}`}>{t('translation.stillWorking')}</p>;
  }

  if (view === 'failed') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className={QUIET_LINE}>{t('translation.failed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={controller.retry} pending={controller.isRetrying}>
          {controller.isRetrying ? t('translation.retrying') : t('translation.retry')}
        </Button>
      </div>
    );
  }

  if (view === 'budget') {
    return <p className={`mt-2 ${QUIET_LINE}`}>{t(translationBudgetKey(controller.refusalReason))}</p>;
  }

  return <p className={`mt-2 ${QUIET_LINE}`}>{t('translation.noEntry')}</p>;
}
