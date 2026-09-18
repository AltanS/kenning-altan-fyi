import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { ThumbsDown, ThumbsUp } from 'lucide-react';

import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { applyVote, submittedVote, type VoteChoice, type VoteTallyView } from '#app/lib/votes/optimistic';
import type { ExplanationVoteOutcome } from '#app/routes/api.explanation-vote';

/**
 * The two vote controls on ONE written explanation.
 *
 * A VOTE JUDGES ONE ANSWER, WHOLE.
 *   An explanation is a single document about a single question, so there is one
 *   control per screen rather than one per row. `explanationId` names a ledger
 *   row and is the only identifier that crosses the wire, which is what keeps
 *   `explanation_votes` free of the question text: the row this posts is an
 *   opinion about a paragraph, never a record of what this reader typed.
 *
 * IT KEEPS THE CONFIRMATION LINE `TranslationVotes` LEAVES OUT.
 *   That control sits on every row of a multi-row answer, where seven copies of
 *   "your vote was counted" would be noise. This one renders once, under one
 *   answer, so the line costs nothing and says plainly that the click landed.
 *   The shape is `EnrichmentVotes`', which sits once under a block for the same
 *   reason.
 *
 * THE BUTTONS ARE SHOWN TO EVERYONE, INCLUDING A READER WITH NO ACCOUNT.
 *   Hiding them from a signed-out visitor would hide the fact that voting exists
 *   at all, and nobody signs in for a feature they were never shown. So the
 *   control is always on the page and the gate speaks only when it is used.
 *
 * NO ENGLISH IS WRITTEN HERE. Every line a reader can see comes from
 * `app/locales`.
 */

export interface ExplanationVotesProps {
  explanationId: string;
  up: number;
  down: number;
  myVote: -1 | 1 | null;
}

/**
 * Which locale key answers each outcome, as a table rather than a chain.
 *
 * A TABLE WITH `satisfies`, so a fourth member added to the union fails the
 * typecheck here instead of silently rendering nothing. `invalid` gets a
 * sentence of its own, unlike the translation control's silent one: these
 * buttons CAN produce it, because the answer on screen may have been removed
 * between the page load and the click, and a reader whose vote vanished with no
 * word for it clicks again.
 */
const OUTCOME_MESSAGE_KEY = {
  unauthenticated: 'explanationVote.signIn',
  invalid: 'explanationVote.invalid',
  recorded: 'explanationVote.recorded',
} satisfies Record<ExplanationVoteOutcome['state'], string>;

/**
 * The score the server last confirmed, or `null` when it has confirmed none.
 *
 * The two refusal outcomes carry no counts, because nothing was written, so they
 * must fall back to the loader's figures rather than to zeroes. Zeroes would
 * blank a real score every time a signed-out reader clicked.
 */
function settledTally(outcome: ExplanationVoteOutcome | undefined): VoteTallyView | null {
  if (outcome === undefined) return null;
  if (outcome.state === 'unauthenticated') return null;
  if (outcome.state === 'invalid') return null;
  return { up: outcome.up, down: outcome.down, myVote: outcome.myVote };
}

export function ExplanationVotes(props: ExplanationVotesProps): ReactNode {
  const { t } = useTranslation();
  const fetcher = useFetcher<ExplanationVoteOutcome>();

  // The loader's figures are the floor. They survive a reload, which is what
  // makes the reader's own vote persist: `myVote` is read per account inside the
  // panel resolver, so a fresh page already knows which button is pressed.
  const loaded: VoteTallyView = { up: props.up, down: props.down, myVote: props.myVote };
  const settled = settledTally(fetcher.data) ?? loaded;
  const inFlight = submittedVote(fetcher.formData);
  const shown = inFlight === null ? settled : applyVote(settled, inFlight);

  const isBusy = fetcher.state !== 'idle';
  const outcome = fetcher.data;
  const messageKey = outcome === undefined ? null : OUTCOME_MESSAGE_KEY[outcome.state];
  const isSignInPrompt = outcome?.state === 'unauthenticated';

  function cast(value: VoteChoice): void {
    const body = new FormData();
    body.set('explanationId', props.explanationId);
    body.set('value', String(value));
    void fetcher.submit(body, { method: 'post', action: '/api/explanation-vote' });
  }

  return (
    <div className="mt-1">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant={shown.myVote === 1 ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={t('explanationVote.up')}
            aria-pressed={shown.myVote === 1}
            disabled={isBusy}
            onClick={() => cast(1)}
          >
            <ThumbsUp aria-hidden="true" />
          </Button>
          {/* The counts sit OUTSIDE the buttons. Inside, the `aria-label` would
              replace them and a screen reader would hear the action and never
              the score. */}
          <span className="text-xs tabular-nums text-muted-foreground">{shown.up}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant={shown.myVote === -1 ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={t('explanationVote.down')}
            aria-pressed={shown.myVote === -1}
            disabled={isBusy}
            onClick={() => cast(-1)}
          >
            <ThumbsDown aria-hidden="true" />
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">{shown.down}</span>
        </div>
      </div>

      {/* THE WHOLE SENTENCE IS THE LINK, and that is not a style choice. A
          separate "Sign in" label would be a word this component invented, and
          `app/locales` has no key for one. Linking the sentence keeps the prompt
          translated and still gives the reader the way in.

          IT APPEARS ONLY AFTER A REFUSED CLICK. A prompt printed under every
          answer would turn a reading screen into a sign-up wall, which is
          exactly what the enrichment control's own comment forbids. It stays
          this quiet; do not make it more prominent. */}
      {messageKey !== null && isSignInPrompt && (
        <p className="mt-2 text-xs">
          <Link to="/sign-in" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
            {t(messageKey)}
          </Link>
        </p>
      )}
      {messageKey !== null && !isSignInPrompt && <p className="mt-2 text-xs text-muted-foreground">{t(messageKey)}</p>}
    </div>
  );
}
