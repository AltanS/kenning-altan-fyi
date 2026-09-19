/**
 * The number a report on a public answer is bounded by.
 *
 * NO IMPORTS, AND NONE MAY BE ADDED. Two routes read this constant in component
 * code, so it reaches the client bundle, and a `.server` import here breaks the
 * production build while typecheck and the tests stay green.
 */

/** The most characters a reason may carry, on a report or a hide. Schemas and inputs cut at this figure. */
export const REPORT_REASON_MAX_CHARS = 500;
