/**
 * Assembling one quiz deck, driven directly against the rule.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - A source order that does not put favourites first, so a reader's own
 *     explicit choices lose a slot to a scaffold word nobody asked for.
 *   - The same word counted twice because it was both favourited and
 *     searched, so a ten-minute quiz spends two of its ten cards on one word.
 *   - A deck longer than `QUIZ_DECK_TARGET_COUNT`, or one that drops below it
 *     for no reason when enough material exists.
 *   - `needsScaffold` reading the wrong side of its own threshold.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewCard } from '#app/lib/review/session';
import {
  assembleQuizDeck,
  needsScaffold,
  QUIZ_DECK_TARGET_COUNT,
  QUIZ_MIN_ORGANIC_BEFORE_SCAFFOLD,
  type QuizDeckSources,
} from '#app/lib/quiz/build-deck';

function card(id: string, lemma: string, translation = `${lemma}-translation`): ReviewCard {
  return { id, lemma, translation, note: '' };
}

function sources(overrides: Partial<QuizDeckSources> = {}): QuizDeckSources {
  return { favorites: [], history: [], explanations: [], scaffold: [], ...overrides };
}

describe('assembleQuizDeck', () => {
  it('puts favourites before history, history before explanations, explanations before scaffold', () => {
    const deck = assembleQuizDeck(
      sources({
        favorites: [card('f1', 'Feierabend')],
        history: [card('h1', 'umwerfen')],
        explanations: [card('e1', 'question about X')],
        scaffold: [card('s1', 'Haus')],
      }),
    );
    assert.deepEqual(
      deck.map((c) => c.id),
      ['f1', 'h1', 'e1', 's1'],
    );
  });

  it('drops the same word once it has already been counted, keeping the higher-priority source', () => {
    const deck = assembleQuizDeck(
      sources({
        favorites: [card('fav', 'Haus', 'ev')],
        scaffold: [card('scaffold', 'haus', 'different-translation')],
      }),
    );
    assert.equal(deck.length, 1);
    assert.equal(deck[0]?.id, 'fav');
    assert.equal(deck[0]?.translation, 'ev');
  });

  it('drops a card with a blank front rather than showing it', () => {
    const deck = assembleQuizDeck(sources({ favorites: [card('blank', '   ')] }));
    assert.deepEqual(deck, []);
  });

  it('caps the deck at QUIZ_DECK_TARGET_COUNT even with plenty of material', () => {
    const many = Array.from({ length: QUIZ_DECK_TARGET_COUNT + 5 }, (_, i) => card(`w${i}`, `word${i}`));
    const deck = assembleQuizDeck(sources({ scaffold: many }));
    assert.equal(deck.length, QUIZ_DECK_TARGET_COUNT);
  });

  it('offers every card when there are fewer than the target, rather than padding', () => {
    const deck = assembleQuizDeck(sources({ favorites: [card('one', 'bir')] }));
    assert.equal(deck.length, 1);
  });
});

describe('needsScaffold', () => {
  it('is true below the threshold and false at or above it', () => {
    assert.equal(needsScaffold(0), true);
    assert.equal(needsScaffold(QUIZ_MIN_ORGANIC_BEFORE_SCAFFOLD - 1), true);
    assert.equal(needsScaffold(QUIZ_MIN_ORGANIC_BEFORE_SCAFFOLD), false);
    assert.equal(needsScaffold(QUIZ_MIN_ORGANIC_BEFORE_SCAFFOLD + 10), false);
  });
});
