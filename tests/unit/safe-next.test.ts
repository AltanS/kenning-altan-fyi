/**
 * Guard: which `next` paths the offline page will send a reader back to.
 *
 * The query string is typed by whoever opens the URL, and the offline page acts
 * on it without being asked, so a crafted link must never move the browser to
 * another origin, back onto the offline page, or onto an account screen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseOfflineNext } from '../../app/lib/auth/safe-next';

describe('parseOfflineNext accepts', () => {
  const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
    ['/', '/'],
    ['/lists', '/lists'],
    ['/?q=Haus', '/?q=Haus'],
    ['/entry/abc?from=de&to=en', '/entry/abc?from=de&to=en'],
    ['/translate?q=%C3%BCber', '/translate?q=%C3%BCber'],
    ['/offlinefoo', '/offlinefoo'],
    ['/a/../b', '/b'],
  ];

  for (const [raw, expected] of ACCEPTED) {
    it(`${raw} as ${expected}`, () => {
      assert.equal(parseOfflineNext(raw), expected);
    });
  }
});

describe('parseOfflineNext refuses', () => {
  const REFUSED: readonly string[] = [
    '',
    'lists',
    'https://evil.example/',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '/\tevil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/offline',
    '/offline/',
    '/Offline',
    '/offline/deeper',
    '/offline?next=%2Foffline',
    '/sign-in',
    '/sign-in?next=%2F',
    '/sign-up',
    '/sign-out',
    '/verify-email',
    '/forgot-password',
    '/reset-password',
    '/Sign-In/',
  ];

  for (const raw of REFUSED) {
    it(JSON.stringify(raw), () => {
      assert.equal(parseOfflineNext(raw), null);
    });
  }

  it('null', () => {
    assert.equal(parseOfflineNext(null), null);
  });
});
