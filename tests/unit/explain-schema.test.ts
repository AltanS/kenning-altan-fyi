/**
 * The shape an explanation must have, and the two things only a refinement can
 * check.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `explanationSchema` is handed to `registry.complete`, so it is the ONLY
 *   thing standing between a model's answer and a stored `ok` row. Two of its
 *   rules are structural rather than per-field, and neither is expressible as a
 *   column type or a field validator:
 *
 *   A CONTRAST ROW IS AS WIDE AS THE HEADER. `byTerm` is one cell per term, in
 *   the order `terms` is in. A row with the wrong number of cells renders a
 *   table whose body does not line up with its head, and nothing downstream can
 *   repair it: no field says which term a missing cell belonged to. The parse
 *   has to refuse it, so the run ends `failed` and the reader gets a retry
 *   button rather than a crooked table.
 *
 *   A COMPARISON NEEDS TWO THINGS TO COMPARE. One term with a contrast row is a
 *   single-column table, which is a list wearing a table's clothes.
 *
 *   And the CEILINGS. A model that ignored the prompt and wrote a two page
 *   answer must fail the parse rather than land an `ok` row nobody can read on a
 *   phone: a silent trim would report success while showing the reader a
 *   different answer than the one that was paid for.
 *
 * NOTHING HERE TOUCHES A DATABASE OR A PROVIDER. The schema is a pure value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXPLAIN_REGISTERS, explanationSchema } from '../../app/lib/llm/explain-schema.ts';

/** One example pair, the smallest a term will accept. */
const example = { text: 'Ich kenne ihn gut.', translation: 'Onu iyi tanırım.' };

/** One term, with every optional field left out. */
function term(name: string) {
  return { term: name, meaning: 'To be acquainted with somebody.', examples: [example] };
}

/** The four lists a minimal answer carries, all empty. */
const EMPTY_LISTS = { terms: [], contrasts: [], pitfalls: [], related: [] };

describe('an explanation with one term', () => {
  it('accepts an answer with no contrasts at all', () => {
    const parsed = explanationSchema.safeParse({
      ...EMPTY_LISTS,
      answer: 'Feierabend is the part of the day after work has finished.',
      terms: [term('Feierabend')],
      pitfalls: ['It is not a holiday.'],
      related: ['Feiertag'],
    });
    assert.equal(parsed.success, true);
  });

  it('accepts a term carrying a register from the closed list', () => {
    for (const register of EXPLAIN_REGISTERS) {
      const parsed = explanationSchema.safeParse({
        ...EMPTY_LISTS,
        answer: 'One word, one register.',
        terms: [{ ...term('Feierabend'), register }],
      });
      assert.equal(parsed.success, true, `register ${register} was rejected`);
    }
  });

  it('refuses a register the card has no label for', () => {
    const parsed = explanationSchema.safeParse({
      ...EMPTY_LISTS,
      answer: 'One word.',
      terms: [{ ...term('Feierabend'), register: 'colloquial' }],
    });
    assert.equal(parsed.success, false);
  });

  it('refuses a contrast on a one-term answer, which compares a word with nothing', () => {
    const parsed = explanationSchema.safeParse({
      ...EMPTY_LISTS,
      answer: 'One word.',
      terms: [term('Feierabend')],
      contrasts: [{ aspect: 'Tone', byTerm: ['neutral'] }],
    });
    assert.equal(parsed.success, false);
  });
});

describe('an explanation comparing two terms', () => {
  /** The answer the operator's own example produces: kennen against wissen. */
  const twoTerms = {
    answer: 'kennen is about people and places, wissen is about facts.',
    terms: [term('kennen'), term('wissen')],
    contrasts: [
      { aspect: 'Object', byTerm: ['a person or a place', 'a fact'] },
      { aspect: 'Typical use', byTerm: ['Ich kenne Berlin.', 'Ich weiss das.'] },
    ],
    pitfalls: ['Do not use wissen for a person.'],
    related: ['erkennen'],
  };

  it('accepts aligned contrasts', () => {
    const parsed = explanationSchema.safeParse(twoTerms);
    assert.equal(parsed.success, true);
  });

  it('refuses a row with fewer cells than there are terms', () => {
    const parsed = explanationSchema.safeParse({
      ...twoTerms,
      contrasts: [{ aspect: 'Object', byTerm: ['a person or a place'] }],
    });
    assert.equal(parsed.success, false);
    // The issue names the row AND the field, so a log line says which row of a
    // four row table was crooked rather than only that the parse failed.
    assert.deepEqual(parsed.error?.issues[0]?.path, ['contrasts', 0, 'byTerm']);
  });

  it('refuses a row with more cells than there are terms', () => {
    const parsed = explanationSchema.safeParse({
      ...twoTerms,
      contrasts: [{ aspect: 'Object', byTerm: ['a person', 'a fact', 'a third thing nobody named'] }],
    });
    assert.equal(parsed.success, false);
  });
});

describe('the ceilings, which are refusals rather than trims', () => {
  it('refuses an answer longer than five hundred characters', () => {
    const parsed = explanationSchema.safeParse({
      ...EMPTY_LISTS,
      answer: 'a'.repeat(501),
    });
    assert.equal(parsed.success, false);
  });

  it('accepts an answer exactly at the cap, so the boundary is not off by one', () => {
    const parsed = explanationSchema.safeParse({ ...EMPTY_LISTS, answer: 'a'.repeat(500) });
    assert.equal(parsed.success, true);
  });

  it('refuses a fourth term, an empty answer and a term with no example', () => {
    const four = ['kennen', 'wissen', 'koennen', 'moegen'].map((name) => term(name));
    assert.equal(explanationSchema.safeParse({ ...EMPTY_LISTS, answer: 'x', terms: four }).success, false);
    assert.equal(explanationSchema.safeParse({ ...EMPTY_LISTS, answer: '' }).success, false);
    assert.equal(
      explanationSchema.safeParse({
        ...EMPTY_LISTS,
        answer: 'x',
        terms: [{ term: 'kennen', meaning: 'to know', examples: [] }],
      }).success,
      false,
    );
  });
});

/**
 * Where to read more.
 *
 * THE DEFAULT IS THE LOAD-BEARING CASE, AND IT IS THE FIRST ONE BELOW. Every row
 * written under prompt v1 is stored with no `references` key, and
 * `app/models/explanations.server.ts` re-parses that document with THIS schema on
 * every read. A required field would turn every answer this installation has
 * already paid for into a row that "does not decode", the resolver would read
 * that as "nothing is coming", and the feature would quietly re-run and re-charge
 * for questions it had already answered.
 *
 * THE URL IS THE ONE FIELD WITH A FORMAT, and the reason it is checked here is
 * that nothing downstream can. The card renders it as an anchor, and a browser
 * will happily make an anchor out of "duden.de/wissen" that goes to a path on
 * this site. So a value that is not an absolute URL has to fail the run.
 */
describe('where to read more', () => {
  /** One well-formed reference with no url, which is the ordinary case. */
  const plain = { title: 'Duden', locator: 'entry "wissen"' };

  it('defaults to an empty list when the key is absent, so a v1 row still decodes', () => {
    const parsed = explanationSchema.safeParse({
      ...EMPTY_LISTS,
      answer: 'Feierabend is the part of the day after work has finished.',
    });

    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data?.references, []);
  });

  it('accepts a reference with no url, and one with an absolute url', () => {
    const parsed = explanationSchema.safeParse({
      ...EMPTY_LISTS,
      answer: 'x',
      references: [plain, { title: 'DWDS', locator: 'entry "wissen"', url: 'https://www.dwds.de/wb/wissen' }],
    });

    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.references[1]?.url, 'https://www.dwds.de/wb/wissen');
  });

  it('refuses a reference whose url is not one', () => {
    const parsed = explanationSchema.safeParse({
      ...EMPTY_LISTS,
      answer: 'x',
      references: [{ title: 'Duden', locator: 'entry "wissen"', url: 'duden.de/rechtschreibung/wissen' }],
    });

    assert.equal(parsed.success, false);
    assert.deepEqual(parsed.error?.issues[0]?.path, ['references', 0, 'url']);
  });

  it('refuses a fourth reference, an empty title and an empty locator', () => {
    assert.equal(
      explanationSchema.safeParse({ ...EMPTY_LISTS, answer: 'x', references: [plain, plain, plain, plain] }).success,
      false,
    );
    assert.equal(
      explanationSchema.safeParse({ ...EMPTY_LISTS, answer: 'x', references: [{ title: '', locator: 'x' }] }).success,
      false,
    );
    assert.equal(
      explanationSchema.safeParse({ ...EMPTY_LISTS, answer: 'x', references: [{ title: 'Duden', locator: '' }] }).success,
      false,
    );
  });

  it('accepts exactly three, so the ceiling is not off by one', () => {
    assert.equal(
      explanationSchema.safeParse({ ...EMPTY_LISTS, answer: 'x', references: [plain, plain, plain] }).success,
      true,
    );
  });
});
