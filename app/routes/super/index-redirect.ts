import { redirect } from 'react-router';

/**
 * `/super` lands on `/super/llm`.
 *
 * Three operator screens live under this prefix: `llm` edits the model
 * configuration enrichment reads, `explanations` is the moderation queue for
 * the public browse pages, and `whoami-ip` answers a question you already
 * know you are asking. So the bare prefix is a hop to the first rather than
 * an index listing three links.
 *
 * A TEMPORARY REDIRECT, unlike the `/sync/*` hops. Those record a rename that
 * is final; this one records today's shape of a small admin surface, and a
 * `301` sitting in an operator's browser cache would outlive the next screen
 * added here.
 *
 * No component and no default export: this file is a hop, not a screen. The
 * superadmin check runs before it, on `routes/_super.tsx`.
 */
export function loader(): Response {
  return redirect('/super/llm');
}
