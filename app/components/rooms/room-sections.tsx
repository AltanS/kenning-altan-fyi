import { useId, useRef, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { BookOpen } from 'lucide-react';

import { CopyTextButton } from '#app/components/copy-text-button';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { Label } from '#app/components/ui/label';
import { Switch } from '#app/components/ui/switch';
import { countRoomTerms, type RoomContent, type RoomRule, type RoomSentence, type RoomTerm } from '#app/lib/rooms/content';
import {
  readItemRevealed,
  readTranslationsHidden,
  revealItem,
  subscribeToPracticePreference,
  writeTranslationsHidden,
  type RoomItem,
} from '#app/lib/rooms/practice-preference';
import { cn } from '#app/lib/utils';

/** The search parameter that keeps the open tab. */
export const ROOM_TAB_PARAM = 'tab';

const ROOM_TABS = ['words', 'sentences', 'rules'] as const;

type RoomTab = (typeof ROOM_TABS)[number];

const TAB_KEYS = {
  words: 'rooms.tabWords',
  sentences: 'rooms.tabSentences',
  rules: 'rooms.tabRules',
} as const satisfies Record<RoomTab, string>;

/** The two languages of one room, as the `lang` attributes and the translator links need them. */
export interface RoomLanguages {
  termLanguage: string;
  glossLanguage: string;
}

const CARD = 'rounded-lg border bg-card p-4';
const SECTION_LABEL = 'text-[11px] font-semibold uppercase tracking-[0.11em] text-brand-ink';

function RoomCopy({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <CopyTextButton
      text={text}
      label={t('rooms.copy', { text })}
      copiedLabel={t('rooms.copied')}
      successMessage={t('rooms.copiedToast')}
      errorMessage={t('rooms.copyFailed')}
    />
  );
}

/** What practice mode needs to know about one item. */
interface Cover extends RoomItem {
  isHidden: boolean;
}

/**
 * Translations that practice mode covers until the reader asks for them. What
 * was revealed is kept for the tab, and the server always renders it unrevealed.
 */
function Coverable({ cover, children }: { cover: Cover; children: ReactNode }) {
  const { t } = useTranslation();
  const isRevealed = useSyncExternalStore(
    subscribeToPracticePreference,
    () => readItemRevealed(cover),
    () => false,
  );

  if (!cover.isHidden || isRevealed) return <div className="flex flex-col gap-1">{children}</div>;
  return (
    <Button type="button" variant="outline" className="min-h-11 self-start border-dashed" onClick={() => revealItem(cover)}>
      {t('rooms.reveal')}
    </Button>
  );
}

/** Type of the term, linked or not, so the two line up. */
const TERM_TYPE =
  // `wrap-anywhere`, not `break-words`: a flex item keeps the width of its
  // longest word otherwise, and one German compound is wider than a phone.
  'font-mono text-lg font-semibold hyphens-auto wrap-anywhere';

/**
 * The term itself. It is a link to the translator only when the dictionary holds
 * the word, and the book glyph and the underline say which kind it is.
 */
function TermHeading({ term, languages, isLinkable }: { term: RoomTerm; languages: RoomLanguages; isLinkable: boolean }) {
  const { t } = useTranslation();
  const { termLanguage, glossLanguage } = languages;
  const spoken = spokenTerm(term);

  if (!isLinkable) {
    return (
      <p lang={termLanguage} className={cn(TERM_TYPE, 'flex min-h-11 items-center')}>
        {spoken}
      </p>
    );
  }
  const query = new URLSearchParams({ q: term.term, from: termLanguage, to: glossLanguage });
  return (
    <Link
      to={`/?${query.toString()}`}
      title={t('rooms.lookUp')}
      className="flex min-h-11 items-center gap-2 underline underline-offset-4 outline-none hover:text-brand-ink focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span lang={termLanguage} className={cn(TERM_TYPE, 'min-w-0')}>
        {spoken}
      </span>
      <BookOpen className="size-4 shrink-0 text-brand-ink" aria-hidden="true" />
      <span className="sr-only">{t('rooms.lookUp')}</span>
    </Link>
  );
}

/** The term with its article, as it is read out and copied. */
function spokenTerm({ article, term }: RoomTerm): string {
  return article === null ? term : `${article} ${term}`;
}

interface TermCardProps {
  term: RoomTerm;
  languages: RoomLanguages;
  cover: Cover;
  isLinkable: boolean;
}

function TermCard({ term, languages, cover, isLinkable }: TermCardProps) {
  const { termLanguage, glossLanguage } = languages;

  return (
    <li className={cn(CARD, 'flex flex-col gap-3')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <TermHeading term={term} languages={languages} isLinkable={isLinkable} />
          <p lang={glossLanguage} className="text-xs text-muted-foreground">
            {term.partOfSpeech}
          </p>
        </div>
        <RoomCopy text={spokenTerm(term)} />
      </div>
      <p lang={termLanguage} className="text-base">
        {term.example}
      </p>
      <Coverable cover={cover}>
        <p lang={glossLanguage} className="text-base font-semibold break-words">
          {term.translation}
        </p>
        <p lang={glossLanguage} className="text-base text-muted-foreground">
          {term.exampleTranslation}
        </p>
        {term.note !== null && (
          <p lang={glossLanguage} className="text-sm text-muted-foreground">
            {term.note}
          </p>
        )}
      </Coverable>
    </li>
  );
}

function SentenceCard({
  sentence,
  languages,
  cover,
}: {
  sentence: RoomSentence;
  languages: RoomLanguages;
  cover: Cover;
}) {
  return (
    <li className={cn(CARD, 'flex flex-col gap-2')}>
      <p lang={languages.glossLanguage} className="text-xs text-muted-foreground">
        {sentence.situation}
      </p>
      <div className="flex items-start justify-between gap-2">
        <p lang={languages.termLanguage} className="min-w-0 text-base font-medium break-words">
          {sentence.sentence}
        </p>
        <RoomCopy text={sentence.sentence} />
      </div>
      <Coverable cover={cover}>
        <p lang={languages.glossLanguage} className="text-base text-muted-foreground">
          {sentence.translation}
        </p>
      </Coverable>
    </li>
  );
}

/** One rule. Practice mode covers the example's translation and never the explanation. */
function RuleCard({ rule, languages, cover }: { rule: RoomRule; languages: RoomLanguages; cover: Cover }) {
  return (
    <li className={cn(CARD, 'flex flex-col gap-2')}>
      <h3 lang={languages.glossLanguage} className="text-base font-semibold">
        {rule.title}
      </h3>
      <p lang={languages.glossLanguage} className="max-w-prose text-sm">
        {rule.explanation}
      </p>
      {rule.example !== null && (
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <p lang={languages.termLanguage} className="text-base font-medium break-words">
              {rule.example}
            </p>
            {rule.exampleTranslation !== null && (
              <Coverable cover={cover}>
                <p lang={languages.glossLanguage} className="text-base text-muted-foreground">
                  {rule.exampleTranslation}
                </p>
              </Coverable>
            )}
          </div>
          <RoomCopy text={rule.example} />
        </div>
      )}
    </li>
  );
}

/** The switch that covers every translation, for practising. */
function PracticeToggle({ isHidden, onChange }: { isHidden: boolean; onChange: (isHidden: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();

  return (
    <div className="flex min-h-11 items-center gap-3">
      <Switch id={id} checked={isHidden} onCheckedChange={onChange} />
      <Label htmlFor={id} className="py-3">
        {t('rooms.hideTranslations')}
      </Label>
    </div>
  );
}

/** One room's "hide translations" choice, kept for the tab. The server always renders them shown. */
function useTranslationsHidden(roomId: string): [boolean, (isHidden: boolean) => void] {
  const isHidden = useSyncExternalStore(
    subscribeToPracticePreference,
    () => readTranslationsHidden(roomId),
    () => false,
  );
  return [isHidden, (next) => writeTranslationsHidden({ roomId, isHidden: next })];
}

export interface RoomSectionsProps {
  roomId: string;
  content: RoomContent;
  languages: RoomLanguages;
  /** The ids of the terms the dictionary holds. */
  linkableTermIds: readonly string[];
}

/**
 * The room itself: words, sentences and rules, one tab each, the open tab kept
 * in the address. A room with no surviving rule has no rules tab.
 *
 * THE TABS ARE LINKS in a `<nav>`, for the reason `mode-switch.tsx` gives: each
 * has an address of its own.
 *
 * THE TABS STICK TO THE TOP OF THE WINDOW. The app header scrolls away with the
 * page, so there is nothing above them to clear.
 */
export function RoomSections({ roomId, content, languages, linkableTermIds }: RoomSectionsProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [isHidden, setIsHidden] = useTranslationsHidden(roomId);
  const linkable = new Set(linkableTermIds);

  const counts = {
    words: countRoomTerms(content),
    sentences: content.sentences.length,
    rules: content.rules.length,
  } satisfies Record<RoomTab, number>;
  const tabs = ROOM_TABS.filter((tab) => counts[tab] > 0);
  const active = tabs.find((tab) => tab === searchParams.get(ROOM_TAB_PARAM)) ?? 'words';
  const coverOf = (itemId: string): Cover => ({ roomId, itemId, isHidden });
  const topRef = useRef<HTMLDivElement>(null);

  /** A tab pressed from further down shows the start of the new section, not its middle. */
  function showSectionStart(event: MouseEvent): void {
    // A modified press opens another tab or window and leaves this one alone.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const top = topRef.current;
    if (top === null || top.getBoundingClientRect().top >= 0) return;
    top.scrollIntoView({ block: 'start' });
  }

  return (
    <div ref={topRef} className="flex flex-col gap-4">
      <div className="sticky top-0 z-30 -my-2 bg-background py-2">
        <nav aria-label={t('rooms.tabsLabel')} className="flex gap-1 rounded-xl border p-1">
          {tabs.map((tab) => (
            <Link
              key={tab}
              to={`?${ROOM_TAB_PARAM}=${tab}`}
              replace
              preventScrollReset
              viewTransition={false}
              onClick={showSectionStart}
              aria-current={tab === active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 flex-1 basis-0 flex-wrap items-center justify-center gap-x-1.5 rounded-lg px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                tab === active ?
                  'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <span>{t(TAB_KEYS[tab])}</span>
              <span className="tabular-nums">{counts[tab]}</span>
            </Link>
          ))}
        </nav>
      </div>

      <PracticeToggle isHidden={isHidden} onChange={setIsHidden} />

      {active === 'words' &&
        content.groups.map((group) => (
          <section key={group.name} className="flex flex-col gap-3">
            <h3 lang={languages.glossLanguage} className={SECTION_LABEL}>
              {group.name}
            </h3>
            <ul className="flex flex-col gap-3">
              {group.terms.map((term) => (
                <TermCard
                  key={term.id}
                  term={term}
                  languages={languages}
                  cover={coverOf(term.id)}
                  isLinkable={linkable.has(term.id)}
                />
              ))}
            </ul>
          </section>
        ))}

      {active === 'sentences' && (
        <ul className="flex flex-col gap-3">
          {content.sentences.map((sentence) => (
            <SentenceCard key={sentence.id} sentence={sentence} languages={languages} cover={coverOf(sentence.id)} />
          ))}
        </ul>
      )}

      {active === 'rules' && (
        <ul className="flex flex-col gap-3">
          {content.rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} languages={languages} cover={coverOf(rule.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}
