/**
 * Guard: a copy control works on an origin with no async clipboard API.
 *
 * WHAT THIS PROTECTS. `navigator.clipboard` exists only in a secure context, so
 * on any plain-http origin that is not localhost, the dev server opened from a
 * phone being the everyday one, it is undefined. The copy buttons used to probe
 * for it and draw themselves permanently disabled there, with nothing on screen
 * saying why. The fallback is what makes those origins work, and a fallback that
 * is never reached is the same as no fallback at all, so the CHOICE between the
 * two paths is what is asserted here.
 *
 * NO DOM, AND THAT IS WHY THE PORT EXISTS. This repo's unit tier has no
 * document, so `copyTextWith` takes the two ways to copy as values and
 * `browserClipboard` is the only thing that touches a real one. The fallback's
 * own DOM steps are therefore not covered here, deliberately: covering them
 * would mean faking a document well enough to be wrong about it.
 *
 * NO ENVIRONMENT PRECONDITION. Nothing here reads a global.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { copyTextWith, type ClipboardPort } from '../../app/lib/copy-text';

/** What one port did, so the choice between the two paths is visible. */
interface Recorder {
  port: ClipboardPort;
  calls: string[];
  written: string[];
}

/**
 * A port that records which path was taken.
 *
 * @param options.writeText What the async writer does, or null for an origin
 *   that does not carry the API at all.
 * @param options.selectionCopies What the fallback answers.
 */
function recorder(options: { writeText: 'ok' | 'rejects' | null; selectionCopies: boolean }): Recorder {
  const calls: string[] = [];
  const written: string[] = [];
  const writeText =
    options.writeText === null ? null : (
      (text: string): Promise<void> => {
        calls.push('writeText');
        if (options.writeText === 'rejects') return Promise.reject(new Error('the clipboard was refused'));
        written.push(text);
        return Promise.resolve();
      }
    );

  return {
    calls,
    written,
    port: {
      writeText,
      copyBySelection: (text: string): boolean => {
        calls.push('selection');
        if (options.selectionCopies) written.push(text);
        return options.selectionCopies;
      },
    },
  };
}

describe('copyTextWith', () => {
  it('uses the async clipboard API when the origin carries one', async () => {
    const recorded = recorder({ writeText: 'ok', selectionCopies: false });

    const copied = await copyTextWith('a word', recorded.port);

    assert.equal(copied, true);
    assert.deepEqual(recorded.calls, ['writeText']);
    assert.deepEqual(recorded.written, ['a word']);
  });

  it('falls back to the selection copy where there is no clipboard API', async () => {
    const recorded = recorder({ writeText: null, selectionCopies: true });

    const copied = await copyTextWith('a word', recorded.port);

    assert.equal(copied, true);
    assert.deepEqual(recorded.calls, ['selection']);
    assert.deepEqual(recorded.written, ['a word']);
  });

  it('reports a failure only when both paths failed', async () => {
    const recorded = recorder({ writeText: null, selectionCopies: false });

    const copied = await copyTextWith('a word', recorded.port);

    assert.equal(copied, false);
    assert.deepEqual(recorded.calls, ['selection']);
  });

  it('falls back when the clipboard API rejects, rather than giving up', async () => {
    const recorded = recorder({ writeText: 'rejects', selectionCopies: true });

    const copied = await copyTextWith('a word', recorded.port);

    assert.equal(copied, true);
    assert.deepEqual(recorded.calls, ['writeText', 'selection']);
  });

  it('refuses an empty string without touching either path', async () => {
    const recorded = recorder({ writeText: 'ok', selectionCopies: true });

    const copied = await copyTextWith('', recorded.port);

    assert.equal(copied, false);
    assert.deepEqual(recorded.calls, []);
  });
});
