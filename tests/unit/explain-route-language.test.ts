/**
 * The explain loader resolves the language of the WORDS, not the language of
 * the question. The question may be written in the reader's UI language.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
mock.module('#app/i18n/meta-title', {
  namedExports: {
    documentTitle: () => '',
    metaLanguage: () => 'en',
    metaTitle: () => '',
  },
});

const detections: Array<{ q: string; from: string; to: string; uiLanguage: string }> = [];
let uiLanguage = 'tr';

mock.module('#drizzle/db', {
  namedExports: { getRawDb: () => ({}) },
});
mock.module('#app/middleware/auth', {
  namedExports: { resolveUser: () => Promise.resolve({ id: 7 }) },
});
mock.module('#app/i18n/language-prefs', {
  namedExports: { resolveRequestLanguage: () => uiLanguage },
});
mock.module('#app/models/user-profiles.server', {
  namedExports: { getUserProfile: () => Promise.resolve(null) },
});
mock.module('#app/lib/dictionary/detect-language', {
  namedExports: {
    detectLanguage: (_db: DictionaryDb, input: (typeof detections)[number]) => {
      detections.push(input);
      return Promise.resolve({ from: input.from, to: input.to });
    },
  },
});
mock.module('#app/lib/translation/explain-panel.server', {
  namedExports: { resolveTriggeredExplainPanel: () => Promise.resolve(null) },
});
mock.module('#app/models/explanation-asks.server', {
  namedExports: { recordExplanationAsk: () => Promise.resolve() },
});

// Import after mock.module registrations so the loader uses the fakes above.
const { loader } = await import('#app/routes/explain');

function routeArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/explain',
    context: new RouterContextProvider(),
  };
}
describe('/explain language resolution', () => {
  it('uses the UI language for detect rather than detecting the question text', async () => {
    const q = 'What is the difference between bitiyor and bitti?';
    await loader(routeArgs(
      new Request(`https://kenning.altan.fyi/explain?q=${encodeURIComponent(q)}&from=detect&to=en`),
    ));

    assert.deepEqual(detections.at(-1), { q, from: 'tr', to: 'en', uiLanguage: 'tr' });
  });

  it('preserves an explicitly selected Turkish-to-English pair', async () => {
    uiLanguage = 'en';
    const q = 'What is the difference between bitiyor and bitti?';
    await loader(routeArgs(
      new Request(`https://kenning.altan.fyi/explain?q=${encodeURIComponent(q)}&from=tr&to=en`),
    ));

    assert.deepEqual(detections.at(-1), { q, from: 'tr', to: 'en', uiLanguage: 'en' });
  });
});
