/**
 * How the offline page decides to take the reader back to a screen.
 *
 * `navigator.onLine` stays true on Wi-Fi with no internet, on a VPN interface
 * and behind a captive portal, so the decision rests on a probe of the server.
 * The decision is pure and takes plain data, so no case touches a browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { chooseReturnPath, probeServer } from '#app/lib/offline/return-path';

describe('chooseReturnPath', () => {
  it('takes a full page load when the server answers and nothing bounced lately', () => {
    assert.equal(chooseReturnPath({ isOnLine: true, isProbeOk: true, hasBouncedRecently: false }), 'full-load');
  });

  it('stays put when the server answers but the last return was under a minute ago', () => {
    assert.equal(chooseReturnPath({ isOnLine: true, isProbeOk: true, hasBouncedRecently: true }), 'stay');
  });

  it('navigates client side when the browser says online but the probe failed', () => {
    assert.equal(chooseReturnPath({ isOnLine: true, isProbeOk: false, hasBouncedRecently: false }), 'client-navigate');
  });

  it('still navigates client side after a recent bounce when the probe failed', () => {
    assert.equal(chooseReturnPath({ isOnLine: true, isProbeOk: false, hasBouncedRecently: true }), 'client-navigate');
  });

  it('navigates client side when the browser says offline, whatever else is true', () => {
    for (const hasBouncedRecently of [false, true]) {
      assert.equal(chooseReturnPath({ isOnLine: false, isProbeOk: false, hasBouncedRecently }), 'client-navigate');
      assert.equal(chooseReturnPath({ isOnLine: false, isProbeOk: true, hasBouncedRecently }), 'client-navigate');
    }
  });
});

const answersWith503: typeof fetch = () => Promise.resolve(new Response('', { status: 503 }));
const rejectsAsOffline: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
const neverAnswers: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

describe('probeServer', () => {
  it('is true for an ok response and asks the build route without the HTTP cache', async () => {
    const seen: { url: string; cache: RequestCache | undefined }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      seen.push({ url: String(input), cache: init?.cache });
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    assert.equal(await probeServer({ fetchImpl }), true);
    assert.deepEqual(seen, [{ url: '/api/build', cache: 'no-store' }]);
  });

  it('is false for a non-ok status', async () => {
    assert.equal(await probeServer({ fetchImpl: answersWith503 }), false);
  });

  it('is false when the fetch rejects', async () => {
    assert.equal(await probeServer({ fetchImpl: rejectsAsOffline }), false);
  });

  it('is false when the server never answers, by aborting at the timeout', async () => {
    assert.equal(await probeServer({ fetchImpl: neverAnswers, timeoutMs: 20 }), false);
  });
});
