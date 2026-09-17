import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { GeneratedMarker } from '#app/components/translation-pane';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { Explanation, ExplanationTerm } from '#app/lib/llm/explain-schema';

/**
 * The answer document, rendered.
 *
 * IT LIVES IN ITS OWN FILE BECAUSE TWO SCREENS DRAW IT. The card under the
 * question box on `/explain` and the saved-ask page at `/explanations/:id` show
 * the same five parts in the same order, and a reader who opens a question they
 * asked last week must meet the answer they already read. Two renderings would
 * be two answers to one question inside a milestone.
 *
 * THE VARIANT CHANGES THE LEAD SIZE AND THE HEADING LEVEL. Nothing else. Not the
 * order, not which section appears, not a single class on a term or a cell. A
 * variant that could reorder anything would be two components sharing a file.
 * The heading level moves because the page variant sits under an `h1` that names
 * the question and the card variant sits under a label, so the same sections are
 * at two different depths in two different documents.
 *
 * THE ORDER IS THE READING ORDER, AND CONTRASTS COME BEFORE THE WORDS. A reader
 * who asked how two words differ has been answered by the lead and the
 * comparison; the per-word detail underneath is what they read next if they want
 * it. The term list used to come first, which put three dictionary entries
 * between the question and its answer.
 */

/** How this body is being shown. See the component doc for what it may change. */
export type ExplanationBodyVariant = 'card' | 'page';

export interface ExplanationBodyProps {
  answer: Explanation;
  /** The language the terms are in. It sets `lang` on every word so a screen reader says them properly. */
  from: LanguageCode;
  /** The language the prose is in, and the target the "also look up" links carry. */
  to: LanguageCode;
  variant: ExplanationBodyVariant;
}

/** The house recipe for a quiet line inside an answer. The same one the translation pane uses. */
const QUIET_LINE = 'text-sm text-muted-foreground';

/**
 * The section heading recipe.
 *
 * SMALL, UPPERCASE AND BRAND-INKED, which is the label treatment the language
 * bar and the input card already use. The sections were `text-sm font-medium`,
 * the same weight as the prose beside them, so the card read as one undivided
 * column of text and the reader had to find the joins by meaning.
 */
const SECTION_HEADING = 'text-[11px] font-semibold uppercase tracking-[0.11em] text-brand-ink';

/** The focus ring every interactive thing in here carries. Keyboard focus is never colour alone. */
const FOCUS_RING = 'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** The id one term block answers to, so the glance row above can jump to it. */
function termAnchorId(index: number): string {
  return `explanation-term-${index}`;
}

/** One section heading, at the depth this variant sits. */
function SectionHeading({ variant, children }: { variant: ExplanationBodyVariant; children: string }) {
  if (variant === 'page') return <h2 className={SECTION_HEADING}>{children}</h2>;
  return <h3 className={SECTION_HEADING}>{children}</h3>;
}

/**
 * Whether a term's register is worth a pill.
 *
 * `neutral` IS NOT, AND THIS IS THE REASON THE TEST EXISTS. The prompt asks the
 * model to leave the field out for an ordinary word, and it does not: two real
 * runs on the dev server came back with `register: "neutral"` on every ordinary
 * term, so every word wore an "everyday" pill. A marker that appears on
 * everything marks nothing.
 *
 * IT IS FILTERED HERE RATHER THAN DROPPED AT THE SCHEMA. `neutral` is a true
 * answer, and a schema that refused it would fail the whole run over a field
 * nobody needed. The stored document keeps it, `explain.register.neutral` keeps
 * its locale key, and only the rendering declines to draw it.
 */
function hasNotableRegister(
  register: ExplanationTerm['register'],
): register is Exclude<ExplanationTerm['register'], undefined | 'neutral'> {
  return register !== undefined && register !== 'neutral';
}

/**
 * The terms as one row of chips, directly under the lead.
 *
 * ONLY WITH TWO OR MORE TERMS, because one chip under a sentence that already
 * names the word says nothing twice.
 *
 * ON THE PAGE VARIANT EACH CHIP JUMPS TO ITS OWN BLOCK. A full page of an answer
 * is longer than a phone screen, so the glance row is also the way down it. In
 * the card the whole answer is a scroll away anyway, so the chips stay plain
 * text rather than becoming controls that barely move the page.
 */
function GlanceRow({ answer, from, variant }: { answer: Explanation; from: LanguageCode; variant: ExplanationBodyVariant }) {
  const { t } = useTranslation();
  const chip = 'font-mono text-sm rounded-full bg-primary/10 px-2.5 py-1 text-brand-ink';

  return (
    <ul aria-label={t('explain.atAGlanceLabel')} className="flex flex-wrap gap-2">
      {answer.terms.map((term, index) => (
        <li key={term.term}>
          {variant === 'page' ?
            <a href={`#${termAnchorId(index)}`} lang={from} className={`${chip} inline-block hover:bg-primary/20 ${FOCUS_RING}`}>
              {term.term}
            </a>
          : <span lang={from} className={`${chip} inline-block`}>
              {term.term}
            </span>
          }
        </li>
      ))}
    </ul>
  );
}

/**
 * The comparison, twice: as a table from `sm` up, and as stacked groups below
 * it.
 *
 * TWO RENDERINGS RATHER THAN ONE SCROLLING TABLE, AND THAT IS DELIBERATE. Three
 * terms plus an aspect column is four columns, which at 390px is either a
 * horizontal scroll trap or four columns of one word each. Neither is readable,
 * and a horizontal scroll inside a vertical page is the kind of thing a reader
 * never discovers is there. The narrow rendering says the same facts in the same
 * order, one aspect at a time.
 *
 * HAIRLINE ROW RULES ONLY. No zebra striping, no vertical rules, and no left
 * border accent, which DESIGN.md section 0 bans outright.
 */
function ContrastTable({
  answer,
  from,
  to,
  variant,
}: {
  answer: Explanation;
  from: LanguageCode;
  to: LanguageCode;
  variant: ExplanationBodyVariant;
}) {
  const { t } = useTranslation();
  const headings = answer.terms.map((term) => term.term);

  return (
    <section className="flex flex-col gap-2 border-t pt-4">
      <SectionHeading variant={variant}>{t('explain.contrastsHeading')}</SectionHeading>

      {/* The wide rendering. `hidden sm:table` rather than a wrapper, so the
          table element itself is what appears: a `<div>` around a `<table>` with
          `display:none` still leaves the table in the accessibility tree twice. */}
      <table className="hidden w-full border-collapse text-sm sm:table">
        <thead>
          <tr className="border-b">
            <th scope="col" className="py-2 pr-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('explain.aspectHeading')}
            </th>
            {headings.map((heading) => (
              <th key={heading} scope="col" lang={from} className="py-2 pr-3 text-left font-mono font-semibold">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {answer.contrasts.map((row) => (
            <tr key={row.aspect} className="border-b last:border-b-0">
              <th
                scope="row"
                lang={to}
                className="py-2 pr-3 text-left align-top text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {row.aspect}
              </th>
              {row.byTerm.map((cell, index) => (
                // The cell's own text is not unique across a row, so the key
                // pairs it with the term it belongs to, which is.
                <td key={`${headings[index] ?? index}`} lang={to} className="py-2 pr-3 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* The narrow rendering: one group per aspect, each term named beside its
          own cell. Same facts, same order, no sideways scroll. */}
      <dl className="flex flex-col gap-3 sm:hidden">
        {answer.contrasts.map((row) => (
          <div key={row.aspect} className="flex flex-col gap-1 border-b pb-3 last:border-b-0 last:pb-0">
            <dt lang={to} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {row.aspect}
            </dt>
            {row.byTerm.map((cell, index) => (
              <dd key={`${headings[index] ?? index}`} className="text-sm">
                <span lang={from} className="font-mono font-semibold">
                  {headings[index]}
                </span>{' '}
                <span lang={to}>{cell}</span>
              </dd>
            ))}
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * One word the question was about: the word, how it is pitched, what it means,
 * and one or two sentences using it.
 *
 * THE MEANING JOINS THE TERM ON ONE BASELINE FROM `sm`. A word and its one-line
 * gloss are one fact, and stacking them put three lines of vertical space
 * between a reader and the examples. Below `sm` they stack, because a 390px line
 * cannot hold both.
 *
 * THE EXAMPLES ARE A QUOTED BLOCK. They are the model's own sentences rather
 * than the app talking, and a wash behind them says so without a label.
 *
 * THE REGISTER PILL IS TRANSLATED, NOT PRINTED. The schema pins the register to
 * a closed list precisely so this lookup is total: `explain.register.<key>`
 * exists for all eight, so a German reader is told `umgangssprachlich` rather
 * than the English string a model happened to write.
 */
function TermBlock({
  term,
  index,
  from,
  to,
}: {
  term: ExplanationTerm;
  index: number;
  from: LanguageCode;
  to: LanguageCode;
}) {
  const { t } = useTranslation();

  return (
    <li id={termAnchorId(index)} className="flex flex-col gap-2 scroll-mt-20">
      <div className="sm:flex sm:items-baseline sm:gap-x-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span lang={from} className="font-mono text-xl font-semibold tracking-tight">
            {term.term}
          </span>
          {hasNotableRegister(term.register) && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-brand-ink">
              {t(`explain.register.${term.register}`)}
            </span>
          )}
        </div>
        <p lang={to} className={QUIET_LINE}>
          {term.meaning}
        </p>
      </div>

      <ul className="rounded-lg bg-muted/40 px-3 py-2 space-y-1">
        {term.examples.map((example) => (
          <li key={example.text}>
            <p lang={from} className="font-mono text-sm">
              {example.text}
            </p>
            <p lang={to} className="text-sm text-muted-foreground">
              {example.translation}
            </p>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Every reference on this answer, and the empty list an older row has.
 *
 * THE `?? []` IS FOR A DOCUMENT THIS BUILD DID NOT PARSE, not for a field the
 * schema might omit. Every answer that reaches here has been through
 * `explanationSchema`, which defaults the list, so the fallback is unreachable
 * on the paths that exist today. It is here because the poll path in
 * `explain-pane.tsx` adopts a JSON body it does not re-parse, and a reader whose
 * answer arrived by poll must not meet a blank screen if that body ever turns
 * out to predate this field.
 */
function referencesOf(answer: Explanation): Explanation['references'] {
  return answer.references ?? [];
}

/**
 * The answer itself.
 *
 * EVERY SECTION IS OMITTED WHEN ITS LIST IS EMPTY. An empty heading promises
 * something the model did not say.
 */
export function ExplanationBody({ answer, from, to, variant }: ExplanationBodyProps) {
  const { t } = useTranslation();
  const references = referencesOf(answer);
  const lead = variant === 'page' ? 'text-base sm:text-lg leading-relaxed' : 'text-base leading-relaxed';

  return (
    <div className="flex flex-col gap-4">
      {/* THE LEAD, AT READING SIZE. It is the answer to the question that was
          asked, so it goes where the eye lands and everything under it is the
          detail behind it. */}
      <p lang={to} className={lead}>
        {answer.answer}
      </p>

      {answer.terms.length >= 2 && <GlanceRow answer={answer} from={from} variant={variant} />}

      {answer.contrasts.length > 0 && <ContrastTable answer={answer} from={from} to={to} variant={variant} />}

      {answer.terms.length > 0 && (
        <section className="flex flex-col gap-4 border-t pt-4">
          <SectionHeading variant={variant}>{t('explain.termsHeading')}</SectionHeading>
          <ul className="flex flex-col gap-4">
            {answer.terms.map((term, index) => (
              <TermBlock key={term.term} term={term} index={index} from={from} to={to} />
            ))}
          </ul>
        </section>
      )}

      {answer.pitfalls.length > 0 && (
        <section className="flex flex-col gap-2 border-t pt-4">
          <SectionHeading variant={variant}>{t('explain.pitfallsHeading')}</SectionHeading>
          {/* AN ICON PER ITEM, NOT A DISC. DESIGN.md section 2: a warning must
              always carry its icon, because under this palette the caution
              colour and the brand colour are the same amber and hue alone
              distinguishes nothing. */}
          <ul lang={to} className="flex flex-col gap-2 text-sm">
            {answer.pitfalls.map((pitfall) => (
              <li key={pitfall} className="flex items-start gap-2">
                <AlertTriangle className="size-4 shrink-0 text-warning mt-0.5" aria-hidden="true" />
                <span>{pitfall}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {answer.related.length > 0 && (
        <section className="flex flex-col gap-2 border-t pt-4">
          <SectionHeading variant={variant}>{t('explain.relatedHeading')}</SectionHeading>
          {/* EACH ONE IS A LINK INTO THE TRANSLATOR, carrying the same pair this
              answer was given in. A related word is only useful if looking it up
              is one tap away, and the translator is where a word is looked up.
              44px on a phone, which is the tap target the rest of this product
              keeps. */}
          <ul className="flex flex-wrap gap-2">
            {answer.related.map((word) => (
              <li key={word}>
                <Link
                  to={`/translate?q=${encodeURIComponent(word)}&from=${from}&to=${to}`}
                  lang={from}
                  className={`inline-flex min-h-11 sm:min-h-8 items-center rounded-full bg-primary/10 px-3 font-mono text-sm text-brand-ink hover:bg-primary/20 ${FOCUS_RING}`}
                >
                  {word}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {references.length > 0 && (
        <section className="flex flex-col gap-2 border-t pt-4">
          <SectionHeading variant={variant}>{t('explain.referencesHeading')}</SectionHeading>
          {/* ONE LINE PER REFERENCE, AND THE WHOLE LINE IS THE LINK WHEN THERE
              IS ONE. A title that linked and a locator that did not would give a
              reader two targets for one pointer, and the smaller of them is the
              one that says where to look. A reference with no url is the
              ordinary case rather than a degraded one: the prompt asks for an
              address only when the model is certain of it, so most of these are
              read out and typed into a search, and the line is written to be
              readable that way.

              THE LINKED ONES ARE UNDERLINED AT REST. DESIGN.md section 2: under
              a monochrome palette colour is never a link's only cue, and the
              arrow icon is the second one. */}
          <ul lang={to} className="flex flex-col gap-1 text-sm">
            {references.map((item) => (
              <li key={`${item.title}::${item.locator}`}>
                {item.url === undefined ?
                  <>
                    <span className="font-medium">{item.title}</span>{' '}
                    <span className="text-muted-foreground">{item.locator}</span>
                  </>
                : <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`underline underline-offset-4 decoration-border hover:decoration-foreground ${FOCUS_RING}`}
                  >
                    <span className="font-medium">{item.title}</span>{' '}
                    <span className="text-muted-foreground">{item.locator}</span>{' '}
                    <ExternalLink className="inline size-3.5 align-baseline" aria-hidden="true" />
                  </a>
                }
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* THE DISCLOSURE, AT THE FOOT, AND IT IS THE TRANSLATOR'S OWN MARKER.
          Every word above was written by a model, so the same badge and the same
          sentence apply, and a second phrasing of the same fact would break
          DESIGN.md section 9 rule 7. */}
      <div className="flex flex-wrap items-baseline gap-2 border-t pt-4">
        <GeneratedMarker />
      </div>
    </div>
  );
}
