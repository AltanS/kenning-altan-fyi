import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { buttonVariants } from '#app/components/ui/button';
import type { SourceSelection } from '#app/lib/dictionary/language-pair';
import { explainSourceLanguage } from '#app/lib/translation/explain-source-language';

export interface ExplainLandingHintProps {
  /** Whether somebody is signed in. A stranger is offered the doors under the line. */
  signedIn: boolean;
  /**
   * The source side of the pair the bar is set to, `detect` included.
   *
   * IT DECIDES WHICH EXAMPLES ARE SHOWN, and that is the whole reason it is
   * here. An example question is written IN the source language and ASKS about
   * words of that language, so a Turkish reader offered a German example has
   * been shown something they cannot read about words they did not ask about.
   */
  source: SourceSelection;
}

/** How many example chips each language offers. The locale keys are `1` to this number. */
const EXAMPLE_COUNT = 3;

/** The id of the question box. It is fixed in `explain-panes.tsx`, which is the only other place it appears. */
const QUESTION_FIELD_ID = 'explain-question';

/**
 * Puts one example in the question box and leaves the cursor there.
 *
 * IT WRITES THROUGH THE NATIVE SETTER AND DISPATCHES `input`, rather than
 * setting `.value` and walking away. The box is uncontrolled, so a plain
 * assignment does put the text on screen, but React never hears about it and the
 * character counter beside it goes on reporting the length of what was there
 * before. The native setter plus a bubbling `input` event is the one way to tell
 * React that a value changed from outside its own handlers.
 *
 * IT DOES NOT SUBMIT, and the buttons are `type="button"` so they cannot. A chip
 * that asked the question outright would spend money on a press a reader made to
 * see what the box wanted. They edit it, or they press Explain.
 */
function fillQuestion(text: string): void {
  const field = document.getElementById(QUESTION_FIELD_ID);
  if (!(field instanceof HTMLTextAreaElement)) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
  field.setSelectionRange(text.length, text.length);
}

/**
 * What the answer region holds before anything has been asked.
 *
 * IT SAYS WHAT THE BOX IS FOR, AND IT IS NOT AN ERROR. DESIGN.md section 9 rule
 * 5: empty is not an error, so this never reads "No results" or "Nothing found".
 *
 * IT SHOWS REAL QUESTIONS, BECAUSE A FREE TEXT BOX IS A BOX MOST READERS WILL
 * NOT TYPE IN. One line describing the two shapes of question this screen
 * answers left the reader to invent one; three they can press are an answer to
 * "like what?". They fill the box rather than asking, so the reader reads the
 * question before it costs anything and can edit it first.
 *
 * IT IS NOT A CARD. The answer card is where an answer goes, and a card here
 * would promise one.
 *
 * THE DOORS ARE HERE FOR A STRANGER ONLY, and they are here at all because a
 * question needs an account: a visitor who types one is redirected to sign in
 * with no warning otherwise. A signed-in reader sees the hint alone.
 */
export function ExplainLandingHint({ signedIn, source }: ExplainLandingHintProps) {
  const { t, i18n } = useTranslation();
  const from = explainSourceLanguage(source, i18n.language);
  const examples = Array.from({ length: EXAMPLE_COUNT }, (_, index) => t(`explain.examples.${from}.${index + 1}`));

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t('explain.landingHint')}</p>

      <ul aria-label={t('explain.examplesLabel')} className="flex flex-wrap gap-2">
        {examples.map((example) => (
          <li key={example}>
            <button
              type="button"
              lang={from}
              onClick={() => fillQuestion(example)}
              className="inline-flex min-h-11 sm:min-h-9 items-center rounded-full border px-3 text-sm hover:border-brand-ink/40 hover:bg-primary/5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {example}
            </button>
          </li>
        ))}
      </ul>

      {!signedIn && (
        <div className="flex flex-wrap items-center gap-4">
          <Link to="/sign-up" className={buttonVariants()}>
            {t('account.createAction')}
          </Link>
          <Link to="/sign-in" className="text-sm underline underline-offset-4 hover:text-foreground">
            {t('account.signInAction')}
          </Link>
        </div>
      )}
    </div>
  );
}
