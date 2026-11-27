/**
 * What a request for a room has to look like, and why one is refused.
 *
 * PURE, AND SAFE FOR THE CLIENT BUNDLE. The language list comes from
 * `language-pair`, never from `detect-language`, which would drag the database
 * schema into the browser.
 */

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { isPairLanguage, partnerLanguage, type LanguagePair } from '#app/lib/dictionary/language-pair';

import { ROOM_TOPIC_MAX_CHARS, ROOM_TOPIC_MIN_CHARS } from './limits';

/** Why a request for a room, or for a new attempt, was turned away. */
export const ROOM_REFUSALS = [
  'topic-too-short',
  'topic-too-long',
  'unsupported-language',
  'same-language',
  'rate-limited',
  'daily-cap',
  'budget',
] as const;

export type RoomRefusal = (typeof ROOM_REFUSALS)[number];

/**
 * The folded topic, which is half of a room's identity.
 *
 * Case, Unicode form and runs of whitespace are folded, so "Copper  Recycling"
 * and "copper recycling" are one room. Nothing else is removed.
 */
export function normalizeRoomTopic(topic: string): string {
  return topic.normalize('NFC').replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

/** A request that passed: the trimmed topic and two different served languages. */
export interface ValidRoomRequest {
  topic: string;
  termLanguage: LanguageCode;
  glossLanguage: LanguageCode;
}

export type RoomRequestCheck = { ok: true; request: ValidRoomRequest } | { ok: false; reason: RoomRefusal };

export interface RoomRequestInput {
  topic: string;
  termLanguage: string;
  glossLanguage: string;
}

/**
 * Check one request. A topic outside the bounds is REFUSED and never cut: a
 * truncated topic would buy a room about something the reader did not ask for.
 */
export function checkRoomRequest(input: RoomRequestInput): RoomRequestCheck {
  const topic = input.topic.trim();
  if (topic.length < ROOM_TOPIC_MIN_CHARS) return { ok: false, reason: 'topic-too-short' };
  if (topic.length > ROOM_TOPIC_MAX_CHARS) return { ok: false, reason: 'topic-too-long' };
  const { termLanguage, glossLanguage } = input;
  if (!isPairLanguage(termLanguage) || !isPairLanguage(glossLanguage)) {
    return { ok: false, reason: 'unsupported-language' };
  }
  if (termLanguage === glossLanguage) return { ok: false, reason: 'same-language' };
  return { ok: true, request: { topic, termLanguage, glossLanguage } };
}

/** The two languages the create form starts on. */
export interface DefaultRoomLanguages {
  termLanguage: LanguageCode;
  glossLanguage: LanguageCode;
}

export interface DefaultRoomLanguagesParams {
  /** The reader's newest room, or null when they have none. */
  newestRoom: { termLanguage: string; glossLanguage: string } | null;
  /** The pair cookie, or null when this device holds none. */
  cookiePair: LanguagePair | null;
  /** The interface language. */
  uiLanguage: string;
}

/**
 * What the two selects start on.
 *
 * The newest room's pair, when there is one. Otherwise the room is explained in
 * the interface language, and its words are in the first language of the
 * reader's pair that differs from it. The two are never equal.
 */
export function defaultRoomLanguages({
  newestRoom,
  cookiePair,
  uiLanguage,
}: DefaultRoomLanguagesParams): DefaultRoomLanguages {
  if (newestRoom !== null) {
    const { termLanguage, glossLanguage } = newestRoom;
    // A stored language that is no longer served cannot seed a select.
    if (isPairLanguage(termLanguage) && isPairLanguage(glossLanguage) && termLanguage !== glossLanguage) {
      return { termLanguage, glossLanguage };
    }
  }
  const glossLanguage = isPairLanguage(uiLanguage) ? uiLanguage : 'en';
  const stated = [cookiePair?.source, cookiePair?.target].find(
    (code): code is LanguageCode => isPairLanguage(code) && code !== glossLanguage,
  );
  return { termLanguage: stated ?? partnerLanguage(glossLanguage), glossLanguage };
}

/** The part of a held room that says which request it answers. */
export interface HeldRoom {
  topic: string;
  termLanguage: string;
  glossLanguage: string;
}

/**
 * The held room this request would open instead of building one, or null. The
 * same identity the database uses: the folded topic and both languages.
 */
export function findHeldRoom<Room extends HeldRoom>(rooms: readonly Room[], request: RoomRequestInput): Room | null {
  const topic = normalizeRoomTopic(request.topic);
  const found = rooms.find(
    (room) =>
      room.termLanguage === request.termLanguage &&
      room.glossLanguage === request.glossLanguage &&
      normalizeRoomTopic(room.topic) === topic,
  );
  return found ?? null;
}

/** Whether the reader holds a room on this topic, in any pair of languages. */
export function holdsRoomTopic(rooms: readonly HeldRoom[], topic: string): boolean {
  const normalized = normalizeRoomTopic(topic);
  return rooms.some((room) => normalizeRoomTopic(room.topic) === normalized);
}
