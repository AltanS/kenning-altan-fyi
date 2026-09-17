/**
 * Workflow Template Registry
 *
 * Centralizes all workflow templates for registration.
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { dummyWorkflowTemplate } from './dummy-workflow';
import { enrichHeadwordTemplate } from './enrich-headword';
import { translateHeadwordTemplate } from './translate-headword';
import { translatePhraseTemplate } from './translate-phrase';
import { explainTermsTemplate } from './explain-terms';

/**
 * All workflow templates with their handler references.
 */
export const workflowTemplates: WorkflowTemplateWithHandlers[] = [
  dummyWorkflowTemplate,
  enrichHeadwordTemplate,
  translateHeadwordTemplate,
  translatePhraseTemplate,
  explainTermsTemplate,
];

// Re-export individual templates for direct access
export { dummyWorkflowTemplate } from './dummy-workflow';
export { enrichHeadwordTemplate } from './enrich-headword';
export { translateHeadwordTemplate } from './translate-headword';
export { translatePhraseTemplate } from './translate-phrase';
export { explainTermsTemplate } from './explain-terms';
