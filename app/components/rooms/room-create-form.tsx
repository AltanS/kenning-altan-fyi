import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Form, useNavigate, useNavigation } from 'react-router';

import { ROOM_REFUSAL_KEYS } from '#app/components/rooms/room-copy-keys';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#app/components/ui/select';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { PAIR_LANGUAGES, isPairLanguage } from '#app/lib/dictionary/language-pair';
import { localizedLanguageName } from '#app/lib/rooms/language-names';
import { ROOM_TOPIC_COUNTER_FROM_CHARS, ROOM_TOPIC_MAX_CHARS, ROOM_TOPIC_MIN_CHARS } from '#app/lib/rooms/limits';
import {
  checkRoomRequest,
  findHeldRoom,
  holdsRoomTopic,
  type DefaultRoomLanguages,
  type HeldRoom,
  type RoomRefusal,
} from '#app/lib/rooms/request';

/** The intent this form posts, which the route action reads. */
export const CREATE_ROOM_INTENT = 'create';

const EXAMPLE_KEYS = [
  'rooms.examples.recycling',
  'rooms.examples.flat',
  'rooms.examples.doctor',
  'rooms.examples.coffee',
] as const;

interface LanguageFieldProps {
  name: 'termLanguage' | 'glossLanguage';
  label: string;
  value: LanguageCode;
  onChange: (value: LanguageCode) => void;
}

/** One language select with its label on screen. */
function LanguageField({ name, label, value, onChange }: LanguageFieldProps) {
  const { i18n } = useTranslation();
  const labelId = useId();

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <input type="hidden" name={name} value={value} />
      <Select
        value={value}
        onValueChange={(next) => {
          if (isPairLanguage(next)) onChange(next);
        }}
      >
        <SelectTrigger aria-labelledby={labelId} className="h-11 w-full data-[size=default]:h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PAIR_LANGUAGES.map((code) => (
            <SelectItem key={code} value={code}>
              {localizedLanguageName({ code, uiLanguage: i18n.language })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The examples a reader has no room on yet. Pressing one fills the field and submits nothing. */
function ExampleTopics({ rooms, onPick }: { rooms: readonly HeldRoom[]; onPick: (topic: string) => void }) {
  const { t } = useTranslation();
  const topics = EXAMPLE_KEYS.map((key) => t(key)).filter((topic) => !holdsRoomTopic(rooms, topic));

  if (topics.length === 0) return null;
  return (
    <ul aria-label={t('rooms.examplesLabel')} className="flex flex-wrap gap-2">
      {topics.map((topic) => (
        <li key={topic}>
          <button
            type="button"
            onClick={() => onPick(topic)}
            className="inline-flex min-h-11 items-center rounded-full border px-3 text-left text-sm outline-none hover:border-brand-ink/40 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:min-h-9"
          >
            {topic}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The one plain sentence that says what the two selects add up to. Nothing while both are the same. */
function ResultSentence({ termLanguage, glossLanguage }: DefaultRoomLanguages) {
  const { t, i18n } = useTranslation();

  if (termLanguage === glossLanguage) return null;
  const nameOf = (code: LanguageCode) => localizedLanguageName({ code, uiLanguage: i18n.language });
  return (
    <p aria-live="polite" className="text-sm text-muted-foreground">
      {t('rooms.result', { term: nameOf(termLanguage), gloss: nameOf(glossLanguage) })}
    </p>
  );
}

/** A room the list holds, as far as the form needs it. */
export type ListedRoom = HeldRoom & { id: string };

export interface RoomCreateFormProps {
  defaults: DefaultRoomLanguages;
  /** The last refused answer of the action, or null. A new submission is a new object. */
  refused: { refusal: RoomRefusal } | null;
  /** The reader's rooms. */
  rooms: readonly ListedRoom[];
}

/**
 * The refusal on screen: the server's newest answer or the browser's own check,
 * until a field changes.
 */
function useShownRefusal(refused: RoomCreateFormProps['refused']) {
  const [shown, setShown] = useState(refused?.refusal ?? null);
  const [seededFrom, setSeededFrom] = useState(refused);
  // In render rather than in an effect, so no frame shows the older one. Only a
  // new answer seeds: a list revalidation drops the answer and must not hide it.
  if (refused !== null && seededFrom !== refused) {
    setSeededFrom(refused);
    setShown(refused.refusal);
  }
  return [shown, setShown] as const;
}

/**
 * The form that asks for a room.
 *
 * THE BROWSER'S OWN CHECK IS `checkRoomRequest`, the one the server runs, so the
 * message is the app's and translated. There is no native `required` bubble.
 *
 * THE LANGUAGES ARE SEEDED ONCE. A later loader answer never moves them while
 * the reader is on the form.
 *
 * A ROOM ALREADY HELD IS OPENED BY NAVIGATING, so the press can spend nothing
 * even when the list on screen is older than the database.
 *
 * AN EXAMPLE FILLS THE FIELD AND DOES NOT SUBMIT, so nothing is spent on a press
 * a reader made to see what the field wants.
 */
export function RoomCreateForm({ defaults, refused, rooms }: RoomCreateFormProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isCreating = navigation.state !== 'idle' && navigation.formData?.get('intent') === CREATE_ROOM_INTENT;
  const [topic, setTopic] = useState('');
  const [termLanguage, setTermLanguage] = useState(defaults.termLanguage);
  const [glossLanguage, setGlossLanguage] = useState(defaults.glossLanguage);
  const [refusal, setRefusal] = useShownRefusal(refused);
  const errorId = useId();
  const counterId = useId();
  const held = findHeldRoom(rooms, { topic, termLanguage, glossLanguage });
  const isTopicRefused = refusal === 'topic-too-short' || refusal === 'topic-too-long';
  const isCounted = topic.length >= ROOM_TOPIC_COUNTER_FROM_CHARS;
  const describedBy = [isCounted ? counterId : null, refusal === null ? null : errorId].filter(Boolean).join(' ');

  /** Every field change clears the message, which was about the old values. */
  function change<Value>(set: (value: Value) => void): (value: Value) => void {
    return (value) => {
      set(value);
      setRefusal(null);
    };
  }
  const changeTopic = change(setTopic);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (held !== null) {
      event.preventDefault();
      void navigate(`/rooms/${held.id}`);
      return;
    }
    const checked = checkRoomRequest({ topic, termLanguage, glossLanguage });
    if (checked.ok) return;
    event.preventDefault();
    setRefusal(checked.reason);
  }

  return (
    <Form method="post" onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-2xl border p-4">
      <input type="hidden" name="intent" value={CREATE_ROOM_INTENT} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="room-topic">{t('rooms.topicLabel')}</Label>
        <Input
          id="room-topic"
          name="topic"
          type="text"
          className="h-11"
          value={topic}
          onChange={(event) => changeTopic(event.target.value)}
          placeholder={t('rooms.topicPlaceholder')}
          autoComplete="off"
          maxLength={ROOM_TOPIC_MAX_CHARS}
          aria-invalid={isTopicRefused || undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
        />
        {isCounted && (
          <p id={counterId} className="self-end text-xs text-muted-foreground tabular-nums">
            {t('rooms.topicCount', { used: topic.length, max: ROOM_TOPIC_MAX_CHARS })}
          </p>
        )}
        <ExampleTopics rooms={rooms} onPick={changeTopic} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <LanguageField
          name="termLanguage"
          label={t('rooms.wordsIn')}
          value={termLanguage}
          onChange={change(setTermLanguage)}
        />
        <LanguageField
          name="glossLanguage"
          label={t('rooms.explainedIn')}
          value={glossLanguage}
          onChange={change(setGlossLanguage)}
        />
      </div>
      <ResultSentence termLanguage={termLanguage} glossLanguage={glossLanguage} />

      {refusal !== null && held === null && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {t(ROOM_REFUSAL_KEYS[refusal], { min: ROOM_TOPIC_MIN_CHARS, max: ROOM_TOPIC_MAX_CHARS })}
        </p>
      )}
      {held !== null && (
        <output className="block text-sm">{t('rooms.alreadyHave')}</output>
      )}

      <Button type="submit" pending={isCreating} className="h-11 w-full sm:w-auto sm:self-start">
        {isCreating && t('rooms.creating')}
        {!isCreating && t(held === null ? 'rooms.create' : 'rooms.openExisting')}
      </Button>
    </Form>
  );
}
