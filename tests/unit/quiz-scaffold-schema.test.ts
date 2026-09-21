/**
 * The quiz scaffold answer schema, driven directly.
 *
 * THE DEFECT THIS CATCHES: an over-length or empty answer reported `ok`
 * rather than failing the run. See `drizzle/schema/quiz.ts` and
 * `app/lib/llm/quiz-scaffold-schema.ts` for why a scaffold run must reject
 * rather than silently trim.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { quizScaffoldAnswerSchema, QUIZ_SCAFFOLD_TARGET_COUNT } from '#app/lib/llm/quiz-scaffold-schema';

function cardsOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({ lemma: `word${i}`, translation: `translation${i}` }));
}

describe('quizScaffoldAnswerSchema', () => {
  it('accepts a card list at the cap', () => {
    const parsed = quizScaffoldAnswerSchema.safeParse({ cards: cardsOf(QUIZ_SCAFFOLD_TARGET_COUNT) });
    assert.equal(parsed.success, true);
  });

  it('rejects a card list over the cap, rather than trimming it', () => {
    const parsed = quizScaffoldAnswerSchema.safeParse({ cards: cardsOf(QUIZ_SCAFFOLD_TARGET_COUNT + 1) });
    assert.equal(parsed.success, false);
  });

  it('rejects an empty card list', () => {
    const parsed = quizScaffoldAnswerSchema.safeParse({ cards: [] });
    assert.equal(parsed.success, false);
  });

  it('accepts a card with no pos and no note, both being optional', () => {
    const parsed = quizScaffoldAnswerSchema.safeParse({ cards: [{ lemma: 'Haus', translation: 'ev' }] });
    assert.equal(parsed.success, true);
  });

  it('rejects a card with a blank lemma', () => {
    const parsed = quizScaffoldAnswerSchema.safeParse({ cards: [{ lemma: '', translation: 'ev' }] });
    assert.equal(parsed.success, false);
  });
});
