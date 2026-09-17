/**
 * Guard: one explanation copies as text that says everything the card says.
 *
 * WHAT THIS PROTECTS. The copy button is the only way an answer leaves this
 * product, and a reader who pastes it into a note has no second chance to notice
 * that the comparison table came out as a row of words with no aspect on it. The
 * shape is checked here rather than by looking at the clipboard, because a join
 * that drops a field is invisible from the outside: what lands still looks like
 * an answer.
 *
 * THE CONTRAST FORMAT IS THE ONE CASE WORTH A TEST OF ITS OWN. `Aspect: term =
 * cell` is the table read aloud, and it is the only part of the text that is not
 * simply the document in order. A tab-separated table would paste into a mail
 * client as a ruin the reader cannot repair, because the column it lost was the
 * header.
 *
 * NO ENVIRONMENT PRECONDITION. `explanationToText` is pure and imports only
 * types.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { explanationToText } from '../../app/lib/translation/explanation-text';
import type { Explanation } from '../../app/lib/llm/explain-schema';

const CONTEXT = { question: 'What is the difference between kennen and wissen?', from: 'de', to: 'en' };

/** A full answer, with every section populated. */
const FULL: Explanation = {
  answer: 'kennen is about people and places, wissen is about facts.',
  terms: [
    {
      term: 'kennen',
      meaning: 'to be acquainted with somebody or something',
      register: 'neutral',
      examples: [{ text: 'Ich kenne sie gut.', translation: 'I know her well.' }],
    },
    {
      term: 'wissen',
      meaning: 'to know a fact',
      examples: [{ text: 'Ich weiss die Antwort.', translation: 'I know the answer.' }],
    },
  ],
  contrasts: [{ aspect: 'Object', byTerm: ['a person or place', 'a fact'] }],
  pitfalls: ['Do not use kennen with a that-clause.'],
  related: ['erkennen', 'kennenlernen'],
  references: [
    { title: 'Duden', locator: 'entry "wissen"' },
    { title: 'DWDS', locator: 'entry "kennen"', url: 'https://www.dwds.de/wb/kennen' },
  ],
};

/** The smallest answer the schema accepts: a lead and nothing else. */
const BARE: Explanation = { answer: 'It is a greeting.', terms: [], contrasts: [], pitfalls: [], related: [], references: [] };

describe('explanationToText', () => {
  it('leads with the question and the pair, so a pasted answer is not half a note', () => {
    const text = explanationToText(FULL, CONTEXT);
    assert.ok(text.startsWith(`${CONTEXT.question}\nde en\n\n`), `The text began: ${JSON.stringify(text.slice(0, 80))}`);
  });

  it('writes one self-describing line per contrast cell', () => {
    const text = explanationToText(FULL, CONTEXT);

    assert.ok(text.includes('Object: kennen = a person or place'), text);
    assert.ok(text.includes('Object: wissen = a fact'), text);
  });

  it('carries every term, meaning and example sentence', () => {
    const text = explanationToText(FULL, CONTEXT);

    assert.ok(text.includes('kennen = to be acquainted with somebody or something'), text);
    assert.ok(text.includes('Ich weiss die Antwort.'), text);
    assert.ok(text.includes('I know the answer.'), text);
  });

  it('carries the pitfalls, the related words and the references', () => {
    const text = explanationToText(FULL, CONTEXT);

    assert.ok(text.includes('- Do not use kennen with a that-clause.'), text);
    assert.ok(text.includes('erkennen, kennenlernen'), text);
    assert.ok(text.includes('Duden, entry "wissen"'), text);
    assert.ok(text.includes('DWDS, entry "kennen" https://www.dwds.de/wb/kennen'), text);
  });

  it('omits every empty section rather than leaving a run of blank lines', () => {
    const text = explanationToText(BARE, CONTEXT);

    assert.equal(text, `${CONTEXT.question}\nde en\n\nIt is a greeting.`);
    assert.ok(!text.includes('\n\n\n'), 'An omitted section left its blank lines behind.');
  });

  it('names no section, so an English label never lands in a German clipboard', () => {
    // THE SHAPE CARRIES THE STRUCTURE, not a heading: this function has no `t`
    // and must not gain one. If a heading is ever added here, it will be in one
    // language over prose the model wrote in another.
    const text = explanationToText(FULL, CONTEXT);

    for (const heading of ['The words', 'How they differ', 'Watch out for', 'Also look up', 'Where to read more']) {
      assert.ok(!text.includes(heading), `The text printed the English section heading "${heading}".`);
    }
  });
});
