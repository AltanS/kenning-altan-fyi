/**
 * Operation Handlers
 *
 * Structured export of all operation handlers for use in workflow templates.
 * This structure enables easy navigation from template to handler.
 *
 * Usage in templates:
 * ```typescript
 * import { operationHandlers } from '../operations';
 *
 * operations: [
 *   {
 *     type: 'dummy.log-start',
 *     handler: operationHandlers.dummy.logStart,
 *   },
 * ]
 * ```
 */

import { logStartHandler, processDataHandler, generateReportHandler } from './dummy';
import { enrichHeadwordHandler } from './enrichment';
import { explainTermsHandler, translateHeadwordHandler, translatePhraseHandler } from './translation';
import { scaffoldVocabHandler } from './quiz';

/**
 * Structured operation handlers organized by domain.
 * Mirrors the stage/operation hierarchy for easy discovery.
 */
export const operationHandlers = {
  dummy: {
    logStart: logStartHandler,
    processData: processDataHandler,
    generateReport: generateReportHandler,
  },
  enrichment: {
    enrichHeadword: enrichHeadwordHandler,
  },
  translation: {
    translateHeadword: translateHeadwordHandler,
    translatePhrase: translatePhraseHandler,
    explainTerms: explainTermsHandler,
  },
  quiz: {
    scaffoldVocab: scaffoldVocabHandler,
  },
} as const;

// Re-export individual handlers for direct access if needed
export { logStartHandler, processDataHandler, generateReportHandler } from './dummy';
export { enrichHeadwordHandler } from './enrichment';
export { explainTermsHandler, translateHeadwordHandler, translatePhraseHandler } from './translation';
export { scaffoldVocabHandler } from './quiz';
