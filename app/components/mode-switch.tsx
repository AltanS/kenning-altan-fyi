import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';

/** Which of the two screens the reader is on. */
export type AppMode = 'translate' | 'explain';

export interface ModeSwitchProps {
  /** The screen this switch is rendered on. Its own segment is the filled one. */
  active: AppMode;
  /**
   * The source side, as the language bar states it.
   *
   * IT IS A STRING RATHER THAN A `LanguageCode`, because the literal `detect` is
   * a legitimate value of that select and the two screens both accept it. The
   * server ignores any `from` it does not serve and falls through to detection,
   * so carrying the reader's own statement across the hop is correct and needs
   * no special case here.
   */
  from: string;
  /** The target side. On `/translate` it is the language to translate into, on `/explain` the language the answer is written in. */
  to: string;
  className?: string;
}

/**
 * The two things this app does, as one control at the top of the input card.
 *
 * IT IS TWO LINKS, NOT A TOGGLE, and that is the whole reason it works. Each
 * segment is a real URL a reader can bookmark, open in a second tab and land on
 * from a search engine, and the back button moves between them. A button that
 * swapped a client-side mode would make `/explain` unreachable by address and
 * would leave the two screens sharing one URL with two meanings.
 *
 * IT CARRIES THE LANGUAGE PAIR ACROSS. A reader who has set German to Turkish
 * and then asks a question has not changed their mind about the languages, and
 * arriving on the other screen with the pair reset to the default would make the
 * switch feel like leaving the app. The QUERY is deliberately NOT carried: a
 * word to translate is not a question to answer, and prefilling "Feierabend"
 * into the question box would start a paid run for a question nobody asked.
 *
 * THE FILLED SEGMENT IS THE ONE PLACE AMBER IS ALLOWED HERE. DESIGN.md section 2
 * keeps the brand hue for filled controls; the inactive segment is plain muted
 * text on the card, so the pair reads as one control with one of its halves
 * pressed rather than as two competing buttons.
 *
 * 40px TAP HEIGHT ON BOTH SEGMENTS, four pixels under the 44px the language
 * bar's selects and the submit button keep. That is deliberate and it is the
 * only control here allowed it: those three ACT on what the reader typed, and a
 * missed tap on one of them costs a search, a wrong language or a paid run.
 * These two are navigation between two screens, and a missed tap costs one more
 * tap. DESIGN.md's 44px rule names the two selects, the swap button and the
 * submit button, and this control is not among them, so the four pixels are
 * spent where they buy the most: back into the space above the fold, on the
 * screen this app is mostly read on. Do not take this as licence to shrink the
 * four controls the rule does name.
 */
export function ModeSwitch({ active, from, to, className }: ModeSwitchProps) {
  const { t } = useTranslation();
  const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const segments = [
    { mode: 'translate', href: `/translate?${query}`, label: t('explain.modeTranslate') },
    { mode: 'explain', href: `/explain?${query}`, label: t('explain.modeExplain') },
  ] as const;

  return (
    // A `<nav>`, not a `tablist`, and not a `<div role="group">`. These are
    // navigations to two DOCUMENTS, not tabs over one: a screen reader told they
    // were tabs would promise that the other panel is already on this page, and
    // the lint gate refuses a `role` a real element already carries.
    // `sm:max-w-sm` IS THE DEFAULT, NOT A CALL-SITE CHOICE. Both screens put
    // this control at the top of their input card, and a two-segment switch
    // stretched across a wide card reads as two page-wide buttons rather than
    // as one control with a half pressed. Setting the cap here is what keeps
    // `/translate` and `/explain` the same width; a call site may still widen
    // or narrow it through `className`.
    <nav
      aria-label={t('explain.modeLabel')}
      className={`flex gap-1 rounded-xl border p-1 sm:max-w-sm ${className ?? ''}`}
    >
      {segments.map((segment) => {
        const isActive = segment.mode === active;
        return (
          <Link
            key={segment.mode}
            to={segment.href}
            // `aria-current="page"` is what tells a screen reader which one the
            // reader is on. The fill alone is a colour-only signal, and this
            // product's palette is close to monochrome by design.
            aria-current={isActive ? 'page' : undefined}
            // `basis-0` with `flex-1` makes the two halves equal by
            // construction. Without it each segment starts at its own text
            // width, so the longer label keeps a wider half at every viewport.
            className={`flex h-10 flex-1 basis-0 items-center justify-center rounded-lg px-4 text-sm font-medium outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
              isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {segment.label}
          </Link>
        );
      })}
    </nav>
  );
}
