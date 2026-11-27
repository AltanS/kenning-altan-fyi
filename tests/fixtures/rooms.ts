/**
 * What the room tests share: a draft a writer could answer with, a review of it,
 * and a fake provider that tells the three calls of a build apart.
 *
 * THE THREE CALLS NEED THREE QUEUES. The two reviewers run side by side, so a
 * single first-in first-out fake would hand their answers out in whichever order
 * they happened to ask. This port reads the first line of the prompt and gives
 * each role its own queue, so "the subject reviewer fails twice" is a thing a
 * test can say.
 *
 * NO NETWORK, EVER, for the reason `fake-llm-port.ts` gives.
 */

import type { LlmPort } from '../../app/lib/llm/registry.server';
import type { RoomDraft, RoomReview } from '../../app/lib/rooms/llm-schema';
import { createFakeLlmPort, type FakeLlmPort, type FakeLlmResponse } from './fake-llm-port';

export interface RoomDraftCounts {
  terms?: number;
  sentences?: number;
  rules?: number;
}

const GROUP_SIZE = 4;

function numbered(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

/** A valid draft with the asked number of items. Terms come in groups of four. */
export function buildRoomDraft({ terms = 12, sentences = 6, rules = 2 }: RoomDraftCounts = {}): RoomDraft {
  const allTerms = numbered(terms).map((index) => ({
    term: `Wort${index}`,
    article: 'das',
    partOfSpeech: 'noun',
    translation: `word ${index}`,
    note: null,
    example: `Das Wort${index} ist hier.`,
    exampleTranslation: `Word ${index} is here.`,
  }));
  const groupCount = Math.ceil(terms / GROUP_SIZE);

  return {
    title: 'Copper recycling',
    summary: 'The words for recycling copper.',
    groups: numbered(groupCount).map((group) => ({
      name: `Group ${group}`,
      terms: allTerms.slice((group - 1) * GROUP_SIZE, group * GROUP_SIZE),
    })),
    sentences: numbered(sentences).map((index) => ({
      sentence: `Satz ${index}.`,
      translation: `Sentence ${index}.`,
      situation: 'At the yard.',
    })),
    rules: numbered(rules).map((index) => ({
      title: `Rule ${index}`,
      explanation: 'Say it this way.',
      example: null,
      exampleTranslation: null,
    })),
  };
}

/** Every id `identifyDraft` hands out for a draft with these counts. */
export function roomItemIds({ terms = 12, sentences = 6, rules = 2 }: RoomDraftCounts = {}): string[] {
  return [
    ...numbered(terms).map((index) => `t${index}`),
    ...numbered(sentences).map((index) => `s${index}`),
    ...numbered(rules).map((index) => `r${index}`),
  ];
}

/** A review of `ids` that accepts everything but the ids in `rejected`. */
export function buildRoomReview({ ids, rejected = [] }: { ids: string[]; rejected?: string[] }): RoomReview {
  return {
    verdicts: ids.map((id) =>
      rejected.includes(id) ?
        { id, verdict: 'reject' as const, reason: 'wrong' }
      : { id, verdict: 'ok' as const, reason: null },
    ),
  };
}

export interface FakeRoomPort {
  port: LlmPort;
  writer: FakeLlmPort;
  language: FakeLlmPort;
  subject: FakeLlmPort;
  /** Provider calls across all three roles. */
  totalCalls: () => number;
}

export interface FakeRoomResponses {
  writer?: FakeLlmResponse[];
  language?: FakeLlmResponse[];
  subject?: FakeLlmResponse[];
}

export function createFakeRoomPort({ writer = [], language = [], subject = [] }: FakeRoomResponses = {}): FakeRoomPort {
  const ports = {
    writer: createFakeLlmPort(writer),
    language: createFakeLlmPort(language),
    subject: createFakeLlmPort(subject),
  };
  const openings = [
    ['You are writing a topic room', ports.writer],
    ['You are the language reviewer', ports.language],
    ['You are the subject reviewer', ports.subject],
  ] as const;

  return {
    ...ports,
    totalCalls: () => ports.writer.callCount + ports.language.callCount + ports.subject.callCount,
    port: {
      async complete(request) {
        const match = openings.find(([opening]) => request.prompt.startsWith(opening));
        if (match === undefined) throw new Error('The fake room port was handed a prompt it does not know');
        return match[1].complete(request);
      },
    },
  };
}
