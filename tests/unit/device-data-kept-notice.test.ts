/**
 * The "your lists stay on this device" line on the account doors.
 *
 * It reads the signed-in hint through `useSyncExternalStore`, whose server
 * snapshot is `null`. Rendering on the server, or hydrating, must therefore draw
 * NOTHING even when the browser holds a hint, so the first client render matches
 * the server's markup. The sentence arrives after hydration. `renderToStaticMarkup`
 * takes the server snapshot, which is exactly the render being pinned.
 */
import { createElement } from 'react';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { createInstance } from 'i18next';

import { DeviceDataKeptNotice } from '#app/components/account/device-data-kept-notice';
import { replaceSignedInHint } from '#app/lib/auth/signed-in-hint';
import enCommon from '#app/locales/en/common.json';

function english() {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: enCommon } },
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
  });
  return instance;
}

describe('DeviceDataKeptNotice', () => {
  it('renders nothing on the server render even when a hint is stored, so hydration cannot mismatch', () => {
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      },
    });
    try {
      replaceSignedInHint(3);
      const markup = renderToStaticMarkup(
        createElement(I18nextProvider, { i18n: english() }, createElement(DeviceDataKeptNotice)),
      );
      assert.equal(markup, '');
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('carries the sentence in the catalog under account.deviceDataKept', () => {
    assert.ok(enCommon.account.deviceDataKept.includes('stay on this device'));
  });
});
