/**
 * The row preview on the public browse list (M200).
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `truncatePreview` decides what a stranger reads under every question on
 *   `/browse/explanations`. The list used to slice the answer at 140 characters,
 *   so a row ended mid-word ("weshalb der Vor") with nothing to say it had been
 *   cut. The rule is now a word boundary and an ellipsis, and every branch of it
 *   is asserted from both sides:
 *
 *   1. A text that fits is returned as it is, including one of exactly the limit.
 *   2. A longer text is cut at the last whitespace that leaves room for the
 *      ellipsis, and the ellipsis counts toward the limit.
 *   3. A cut that lands after `,`, `;` or `:` drops it, so a row never ends on a
 *      clause that promises more.
 *   4. A text with no whitespace to cut at is cut hard and stays inside the
 *      limit, and the hard cut never keeps half of a surrogate pair.
 *
 * NO DATABASE, NO NETWORK. The function is pure. The module it lives in imports
 * the schema and opens no pool, which `explanation-settle-values.test.ts` relies
 * on for its own model in the same way.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PUBLIC_PREVIEW_CHARS, truncatePreview } from '../../app/models/explanation-browse.server';

const ELLIPSIS = '…';

describe('truncatePreview: a text that fits', () => {
  it('returns a short text unchanged, with no ellipsis', () => {
    assert.equal(truncatePreview('Kurz und klar.'), 'Kurz und klar.');
  });

  it('returns a text of exactly the limit unchanged', () => {
    const exact = 'a'.repeat(PUBLIC_PREVIEW_CHARS);

    assert.equal(truncatePreview(exact), exact);
  });
});

describe('truncatePreview: a text with spaces in it', () => {
  it('cuts at a word boundary and ends with an ellipsis, inside the limit', () => {
    const text = 'Konjunktiv '.repeat(20).trimEnd();

    const preview = truncatePreview(text);

    // A raw slice at 140 would end inside the thirteenth "Konjunktiv"; the cut
    // backs off to the space after the twelfth and keeps whole words only.
    assert.equal(preview, `${'Konjunktiv '.repeat(12).trimEnd()}${ELLIPSIS}`);
    assert.ok(preview.length <= PUBLIC_PREVIEW_CHARS, `preview is ${preview.length} characters long`);
  });

  it('counts the ellipsis toward the limit, so a space on the cut fills it exactly', () => {
    const text = `${'a'.repeat(PUBLIC_PREVIEW_CHARS - 1)} ${'b'.repeat(20)}`;

    const preview = truncatePreview(text);

    assert.equal(preview, `${'a'.repeat(PUBLIC_PREVIEW_CHARS - 1)}${ELLIPSIS}`);
    assert.equal(preview.length, PUBLIC_PREVIEW_CHARS);
  });

  it('honours a limit passed in, not only the default', () => {
    assert.equal(truncatePreview('one two three', 8), `one two${ELLIPSIS}`);
  });
});

describe('truncatePreview: a cut after punctuation', () => {
  for (const mark of [',', ';', ':']) {
    it(`drops a trailing "${mark}" before the ellipsis`, () => {
      const text = `${'x'.repeat(130)}${mark} ${'y'.repeat(50)}`;

      assert.equal(truncatePreview(text), `${'x'.repeat(130)}${ELLIPSIS}`);
    });
  }

  it('drops a whole run of whitespace and punctuation, not one character of it', () => {
    const text = `${'x'.repeat(120)} ,; ${'y'.repeat(50)}`;

    assert.equal(truncatePreview(text), `${'x'.repeat(120)}${ELLIPSIS}`);
  });
});

describe('truncatePreview: a text with no whitespace to cut at', () => {
  it('cuts hard and stays inside the limit', () => {
    const preview = truncatePreview('x'.repeat(300));

    assert.equal(preview, `${'x'.repeat(PUBLIC_PREVIEW_CHARS - 1)}${ELLIPSIS}`);
    assert.equal(preview.length, PUBLIC_PREVIEW_CHARS);
  });

  it('cuts hard when the only whitespace is a leading space, rather than returning a bare ellipsis', () => {
    const preview = truncatePreview(` ${'z'.repeat(300)}`);

    assert.ok(preview.length > 1, 'the preview is only an ellipsis');
    assert.ok(preview.length <= PUBLIC_PREVIEW_CHARS, `preview is ${preview.length} characters long`);
    assert.ok(preview.endsWith(ELLIPSIS));
  });

  it('never keeps half of a surrogate pair at the hard cut', () => {
    // 138 letters, then emoji. The budget of 139 falls between the two halves of
    // the first emoji, so a raw slice would end on a lone high surrogate.
    const text = `${'a'.repeat(138)}${'\u{1F600}'.repeat(5)}`;

    const preview = truncatePreview(text);

    assert.equal(preview, `${'a'.repeat(138)}${ELLIPSIS}`);
    assert.ok(preview.length <= PUBLIC_PREVIEW_CHARS);
  });
});
