/**
 * The install card on the settings screen, driven by a fixed `InstallOffer`.
 *
 * There is no DOM library in this repo (see `voice-input.test.ts`), so
 * `InstallCard` is rendered through `react-dom/server`, which needs no DOM.
 * `InstallCard` is the presentational half of `install-app.tsx`, split out for
 * exactly this: `InstallApp` itself calls `useInstallPrompt`, which reads
 * `window`, so only `InstallCard` can be driven with a state fixed by the test
 * rather than by whatever a headless runner's `window` happens to answer.
 *
 * THE DEFECT THIS GUARDS. The card used to render nothing unless the browser
 * handed the page a `beforeinstallprompt` event, which meant iOS, Firefox and
 * Samsung Internet readers, and any Chrome reader whose hydration lost the
 * race with the event, found no install control at all. Every one of the
 * offer's four states is asserted below, and `pending` is the ONLY one that
 * may render nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { InstallCard } from '#app/components/install-app';
import type { InstallOffer } from '#app/hooks/use-install-prompt';
import enCommon from '#app/locales/en/common.json';

/** The English catalogue in a bare i18next instance: no cookie detector, no singleton. */
function englishInstance() {
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

/** The card rendered for one fixed offer, as static markup. */
function renderCard(offer: InstallOffer): string {
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n: englishInstance() }, createElement(InstallCard, { offer })),
  );
}

describe('the install card', () => {
  it('renders nothing before mount has answered', () => {
    const markup = renderCard({ kind: 'pending' });
    assert.equal(markup, '', `pending must render nothing, got: ${markup}`);
  });

  it('offers the real install button once a beforeinstallprompt event is in hand', () => {
    const markup = renderCard({ kind: 'ready', install: () => undefined });
    assert.ok(markup.includes('<button'), `ready must render a control, got: ${markup}`);
    assert.ok(markup.includes(enCommon.settings.installAction), 'the install label is missing');
  });

  it('shows the installed note, with no button, once the app is already on the device', () => {
    const markup = renderCard({ kind: 'installed' });
    assert.ok(
      markup.includes(enCommon.settings.installedNote),
      `the installed note is missing from: ${markup}`,
    );
    assert.ok(!markup.includes('<button'), `an installed device must get no button, got: ${markup}`);
  });

  it('offers the iOS steps behind a button, never an empty card', () => {
    const markup = renderCard({ kind: 'manual', platform: 'ios' });
    assert.ok(markup.includes('<button'), `manual must still render a control, got: ${markup}`);
    assert.ok(
      markup.includes('aria-expanded="false"') && markup.includes('aria-controls="install-manual-steps"'),
      `the disclosure button is missing its aria wiring, got: ${markup}`,
    );
    // Collapsed by default: the steps are not in the initial markup, only the
    // control that reveals them.
    assert.ok(
      !markup.includes(enCommon.settings.installStepsIos),
      `the iOS steps must stay collapsed until opened, got: ${markup}`,
    );
  });

  it('offers the Android steps behind the same disclosure', () => {
    const markup = renderCard({ kind: 'manual', platform: 'android' });
    assert.ok(markup.includes('<button'), `manual must still render a control, got: ${markup}`);
    assert.ok(
      !markup.includes(enCommon.settings.installStepsAndroid),
      `the Android steps must stay collapsed until opened, got: ${markup}`,
    );
  });

  it('offers the desktop steps behind the same disclosure', () => {
    const markup = renderCard({ kind: 'manual', platform: 'desktop' });
    assert.ok(markup.includes('<button'), `manual must still render a control, got: ${markup}`);
    assert.ok(
      !markup.includes(enCommon.settings.installStepsDesktop),
      `the desktop steps must stay collapsed until opened, got: ${markup}`,
    );
  });
});
