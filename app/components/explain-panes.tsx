import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Form, useNavigation } from 'react-router';
import type { ExplainPaneController } from '#app/components/explain-pane';
import { ExplanationCard } from '#app/components/explanation-card';
import { LanguageBar } from '#app/components/language-bar';
import { Link } from '#app/components/link';
import { ModeSwitch } from '#app/components/mode-switch';
import { Button } from '#app/components/ui/button';
import { Textarea } from '#app/components/ui/textarea';
import type { Direction } from '#app/lib/dictionary/detect-language';
import type { LanguagePair } from '#app/lib/dictionary/language-pair';
import { explainSourceLanguage } from '#app/lib/translation/explain-source-language';
import { EXPLAIN_MAX_QUESTION_CHARS } from '#app/lib/translation/limits';

/**
 * At what fraction of the cap the character counter appears.
 *
 * A COUNTER THAT IS ALWAYS THERE IS NOISE, and a cap a reader only learns about
 * by being refused is worse. Eighty percent is late enough that an ordinary
 * question never sees it, and early enough that a reader who is going to hit the
 * cap is told before they do.
 */
const COUNTER_THRESHOLD = 0.8;

/** The locale keys of the visibility notice, one per line. */
const VISIBILITY_NOTICE_KEYS = {
  listed: 'explain.publicNoticeListed',
  hidden: 'explain.publicNoticeHidden',
  link: 'explain.publicNoticeSettingsLink',
} as const;

/** One rendered state of the explain surface, exactly as the loader answers it. */
export interface ExplainPanesProps {
  /** The question on screen, from the URL. Empty is the landing state. */
  q: string;
  /** The direction the pair resolved to. The language bar needs it to label a detected source. */
  direction: Direction;
  /** The language pair the bar is set to, resolved from the URL, then the cookie, then the default. */
  pair: LanguagePair;
  /**
   * The pane's whole behaviour, held by the CALLER.
   *
   * The same split `SearchPanes` makes, and for the same reason: this route is
   * gated, so any non-empty question needs an account, and handing the
   * controller in is the only way to render an answered surface without a
   * session. The component stays pure over its props.
   */
  explanation: ExplainPaneController;
  /**
   * What the answer region holds while nothing has been asked.
   *
   * The caller decides what goes there; this component only decides that it goes
   * THERE rather than under everything, so a first visit meets the question box
   * and then the place an answer will appear.
   */
  emptyPane?: ReactNode;
  /**
   * Whether this reader's new questions start out hidden from the public pages.
   * `null` for a visitor with no account, who is shown no notice.
   */
  hideByDefault?: boolean | null;
}

/**
 * The explain surface: a question box, and the answer directly underneath it.
 *
 * IT IS THE TRANSLATOR SURFACE'S SIBLING, NOT A NEW KIND OF SCREEN. One column
 * at every width inside `mx-auto max-w-2xl`, the language bar, then the input
 * card, then the answer card, all exactly as wide as each other, both cards
 * `rounded-2xl border p-4` with no brand wash. That is DESIGN.md section 3's
 * translator recipe applied unchanged: a reader moving between the two screens
 * with the mode switch must not feel they have left the product.
 *
 * THE MODE SWITCH IS INSIDE THE INPUT CARD, AT THE TOP, and the same control
 * sits in the same place on `/translate`. It is the first thing in the card
 * because it answers the question the card then asks: what kind of thing am I
 * typing here.
 *
 * THE TARGET SELECT MEANS SOMETHING DIFFERENT HERE, AND THE LABEL SAYS SO. On
 * the translator it is the language to translate into; here it is the language
 * the explanation is WRITTEN IN. The bar is the same component, so the
 * difference lives entirely in the sentence above it.
 *
 * SUBMIT IS A GET, so the answer is linkable and correct under the back button,
 * exactly like a search. There is no client state on this screen at all.
 */
export function ExplainPanes({ q, direction, pair, explanation, emptyPane, hideByDefault = null }: ExplainPanesProps) {
  const { t, i18n } = useTranslation();
  const navigation = useNavigation();
  const isAsking = navigation.state !== 'idle';
  const formRef = useRef<HTMLFormElement>(null);
  const [length, setLength] = useState(q.length);

  // ENTER ASKS. A `<textarea>` takes Enter as a newline, and a question box that
  // needed a mouse to submit would be the one control on this screen that does
  // not behave like the box on the other one. Shift keeps the newline, which is
  // the convention every message box uses.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  };

  const showCounter = length >= EXPLAIN_MAX_QUESTION_CHARS * COUNTER_THRESHOLD;

  // THE SOURCE SIDE IS ALWAYS A REAL LANGUAGE HERE, and this is where a stored
  // `detect` becomes one. The bar offers no detection on this screen, so a pair
  // carried over from the translator, or read out of the cookie, can still say
  // `detect` and would render a select with no matching option: an empty
  // trigger, and a submitted `from=detect` that the loader would then resolve
  // off the QUESTION rather than off the words it asks about. The reader's own
  // UI language is the best guess available without reading their text, and
  // German is the fallback, which is what the language-pair default already
  // says.
  const stated: LanguagePair = { source: explainSourceLanguage(pair.source, i18n.language), target: pair.target };

  return (
    <div className="flex flex-col gap-4">
      <Form method="get" ref={formRef} className="flex flex-col gap-4">
        {/* Keyed on the pair, so a navigation re-seeds the two selects. The URL
            is the source of truth across navigations; the bar's own state only
            exists so both sides can be edited before a submit. */}
        <LanguageBar
          key={`${stated.source}:${stated.target}`}
          pair={stated}
          direction={direction}
          q={q}
          formRef={formRef}
          // THE LABELS ARE WHERE THIS SCREEN DIFFERS FROM THE TRANSLATOR. The
          // target select does not name a translation target here, it names the
          // language the answer is written in, and the sentence that used to say
          // so sat under the question box as a line of prose nobody connected to
          // a control two blocks above it. Said on the control itself, it needs
          // no sentence.
          labels={{ source: t('explain.wordsIn'), target: t('explain.explainIn') }}
          allowDetect={false}
        />

        {/* `p-4` AND `mb-3`, THE SAME NUMBERS THE TRANSLATOR CARD CARRIES. The
            two screens are one product under a switch the reader taps between,
            so a card that padded itself differently would read as a jump. */}
        <div className="rounded-2xl border p-4">
          <ModeSwitch active="explain" from={stated.source} to={stated.target} className="mb-3" />

          {/* ONE COLUMN WITH ONE GAP, rather than a stack of hand-set top
              margins. The label, the box and the counter are one field, and
              spacing them individually is how the counter came to sit closer to
              the submit button than to the text it counts. */}
          <div className="flex flex-col gap-2">
            <label htmlFor="explain-question" className="text-sm font-medium">
              {t('explain.fieldLabel')}
            </label>
            <Textarea
              id="explain-question"
              name="q"
              rows={2}
              defaultValue={q}
              maxLength={EXPLAIN_MAX_QUESTION_CHARS}
              placeholder={t('explain.placeholder')}
              autoComplete="off"
              // `field-sizing-content` on the shared component grows the box
              // with what is typed; the floor is two rows and the ceiling four,
              // so a long question scrolls inside the box instead of pushing
              // the answer off the screen.
              className="min-h-16 max-h-32"
              onKeyDown={handleKeyDown}
              onChange={(event) => setLength(event.target.value.length)}
            />
            {/* THE COUNTER APPEARS LATE, AND ONLY THEN. See `COUNTER_THRESHOLD`.
                `aria-live="polite"` so a screen reader hears the count change
                without the box losing focus. */}
            {showCounter && (
              <p aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
                {t('explain.counter', { count: length, max: EXPLAIN_MAX_QUESTION_CHARS })}
              </p>
            )}
            {hideByDefault !== null && (
              <p className="text-xs text-muted-foreground">
                {t(hideByDefault ? VISIBILITY_NOTICE_KEYS.hidden : VISIBILITY_NOTICE_KEYS.listed)}{' '}
                <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
                  {t(VISIBILITY_NOTICE_KEYS.link)}
                </Link>
              </p>
            )}
          </div>
          <div className="mt-3 flex">
            {/* Full width below `sm`, which is DESIGN.md section 3's rule for
                this screen's primary action. It has the row to itself here:
                there is no voice control on a question box, because a spoken
                question is a search box feature and this screen is not one. */}
            <Button type="submit" pending={isAsking} className="h-11 w-full sm:w-auto">
              {isAsking ? t('explain.submitting') : t('explain.submit')}
            </Button>
          </div>
        </div>
      </Form>

      {/* THE ANSWER REGION, DIRECTLY UNDER THE INPUT CARD, and OUTSIDE the form
          above: the retry button inside the card is a control, and a control
          inside a GET form submits the question. `aria-live` stays on the
          section so an answer that arrives by poll is announced. */}
      <section aria-live="polite" className="flex flex-col gap-4">
        {q === '' && emptyPane}
        {q !== '' && <ExplanationCard controller={explanation} question={q} from={direction.from} to={direction.to} />}
      </section>
    </div>
  );
}
