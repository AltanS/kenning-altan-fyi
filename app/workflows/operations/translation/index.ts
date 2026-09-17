/**
 * Translation Operation Handlers
 *
 * Export all translation workflow operation handlers.
 */

export { translateHeadwordHandler, runTranslateHeadword, type TranslationRunSummary } from './translate-headword';
export { translatePhraseHandler, runTranslatePhrase, type PhraseRunSummary } from './translate-phrase';
export { explainTermsHandler, runExplainTerms, type ExplainRunSummary } from './explain-terms';
