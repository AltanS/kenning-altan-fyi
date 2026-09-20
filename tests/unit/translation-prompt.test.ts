/**
 * The translation prompt template, and the re-run it now has to be able to ask.
 *
 * WHY THIS FILE IS WORTH ITS OWN TEST
 *   A re-run exists because a plain second call to the same prompt returns the
 *   same words. The only thing that makes the second call a different question
 *   is what the rendered text says: that the dictionary already holds something,
 *   which words those are, and that a reader judged the set insufficient. None
 *   of that is checkable anywhere downstream. The model would answer, the answer
 *   would parse, and the reader would press a button and watch the identical two
 *   words come back.
 *
 * AND THE FIRST RUN IS PINNED IN THE SAME FILE, on purpose. The two renders come
 * out of one template through one substitution pass, so the revision block is
 * one editing mistake away from appearing on every first run, and the first-run
 * paragraph is one mistake away from telling a re-run that the dictionary is
 * empty.
 *
 * THE PLACEHOLDER GUARD IS ASSERTED ON BOTH PATHS. `substitutePlaceholders`
 * throws on an unresolved `{{...}}`, so a surviving placeholder would already
 * fail loudly; what the `{{` assertions add is the case the guard cannot see,
 * a placeholder that this module substituted INTO the template after the pass
 * had already run over it.
 *
 * NO DATABASE AND NO NETWORK. The module reads one markdown file from disk and
 * nothing else.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderTranslationPrompt, type RenderTranslationPromptParams } from '../../app/prompts/translation';

/**
 * A fresh set of parameters per call, rather than one shared object.
 *
 * `renderTranslationPrompt` takes mutable arrays, so a shared literal would have
 * to be spread at every call site anyway; a factory says once what every case
 * starts from.
 */
function base(): RenderTranslationPromptParams {
  return {
    lemma: 'Baumstämme',
    pos: 'noun',
    from: 'de',
    to: 'tr',
    senses: [{ senseId: 'sense-1', glosses: ['der Stamm eines Baumes'] }],
  };
}

describe('renderTranslationPrompt, a first run', () => {
  it('says the dictionary has no translation yet, and carries no revision block', () => {
    const prompt = renderTranslationPrompt(base());

    assert.match(prompt, /The dictionary has no translation for it yet/);
    assert.doesNotMatch(prompt, /Already in the dictionary/);
    assert.equal(prompt.includes('insufficient'), false, 'a first run claimed a reader rejected something');
  });

  it('leaves no placeholder behind', () => {
    const prompt = renderTranslationPrompt(base());
    assert.equal(prompt.includes('{{'), false, prompt);
  });

  it('renders identically whether revision is omitted, null, or an empty list', () => {
    const omitted = renderTranslationPrompt(base());
    const explicitNull = renderTranslationPrompt({ ...base(), revision: null });
    const emptyList = renderTranslationPrompt({
      ...base(),
      revision: { existingLemmas: [], reason: 'missing' },
    });

    assert.equal(explicitNull, omitted);
    // An empty list is a retracted set, not a set to avoid. Asking the model to
    // return the renderings that nothing is missing is noise in a paid prompt.
    assert.equal(emptyList, omitted);
  });
});

describe('renderTranslationPrompt, a re-run', () => {
  const REVISION = { existingLemmas: ['gövde', 'tomruk'], reason: 'missing' } as const;

  function renderRerun(): string {
    return renderTranslationPrompt({
      ...base(),
      revision: { existingLemmas: [...REVISION.existingLemmas], reason: REVISION.reason },
    });
  }

  it('stops claiming the dictionary is empty', () => {
    const prompt = renderRerun();

    assert.match(prompt, /The dictionary already holds the translations listed below/);
    assert.equal(
      prompt.includes('The dictionary has no translation for it yet'),
      false,
      'a re-run told the model the dictionary was empty over a list of what is in it',
    );
  });

  it('lists every supplied lemma', () => {
    const prompt = renderRerun();
    assert.match(prompt, /## Already in the dictionary/);
    for (const lemma of REVISION.existingLemmas) {
      assert.ok(prompt.includes(`- ${lemma}`), `the prompt did not list "${lemma}"`);
    }
  });

  it('carries the sentence for the reason the reader gave', () => {
    assert.match(renderRerun(), /A reader judged that set insufficient, and said: a word is missing from this set\./);

    const wrong = renderTranslationPrompt({
      ...base(),
      revision: { existingLemmas: ['gövde'], reason: 'wrong' },
    });
    assert.match(wrong, /one or more of these words does not mean the headword\./);

    const register = renderTranslationPrompt({
      ...base(),
      revision: { existingLemmas: ['gövde'], reason: 'register' },
    });
    assert.match(register, /the register or the usage note is wrong\./);

    const other = renderTranslationPrompt({
      ...base(),
      revision: { existingLemmas: ['gövde'], reason: 'other' },
    });
    assert.match(other, /the answer is not good enough, without saying which part\./);
  });

  it('asks for what is missing rather than for a rewrite', () => {
    const prompt = renderRerun();
    assert.match(prompt, /Return the renderings that set is MISSING/);
    assert.match(prompt, /return no translations for that sense at all/);
  });

  it('resolves the target language named INSIDE the block, and leaves no placeholder', () => {
    const prompt = renderRerun();

    // The block is substituted INTO the template, so the pass that resolves
    // `{{toLanguageName}}` has already run over the template by the time the
    // block arrives. If the block's own copy were not resolved first, the guard
    // would never see it and the model would be told about "{{toLanguageName}}
    // words".
    assert.match(prompt, /The following Turkish words are already recorded for this headword:/);
    assert.equal(prompt.includes('{{'), false, prompt);
  });
});
