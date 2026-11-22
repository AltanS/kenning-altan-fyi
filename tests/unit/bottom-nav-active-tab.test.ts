/**
 * Which mobile tab lights up for a URL.
 *
 * `/explanations` and `/explanations/:id` are the saved answers of Explain and
 * the bar has no tab of their own, so they highlight Explain. The sidebar and
 * the drawer keep the longest-match rule, and the last test pins that.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { activeNavigationHref, activeTabHref } from '#app/components/app-sidebar';

describe('activeTabHref', () => {
  it('lights Explain for /explain, /explanations and one saved answer', () => {
    assert.equal(activeTabHref('/explain'), '/explain');
    assert.equal(activeTabHref('/explanations'), '/explain');
    assert.equal(activeTabHref('/explanations/abc-123'), '/explain');
  });

  it('lights Translate only for the root', () => {
    assert.equal(activeTabHref('/'), '/');
    assert.equal(activeTabHref('/entry/42'), null);
  });

  it('lights Lists for a list and its review', () => {
    assert.equal(activeTabHref('/lists'), '/lists');
    assert.equal(activeTabHref('/lists/abc'), '/lists');
    assert.equal(activeTabHref('/lists/abc/review'), '/lists');
  });

  it('lights Favourites and History for their own pages', () => {
    assert.equal(activeTabHref('/favourites'), '/favourites');
    assert.equal(activeTabHref('/history'), '/history');
  });

  it('lights no tab for a page the bar does not carry', () => {
    assert.equal(activeTabHref('/settings'), null);
    assert.equal(activeTabHref('/quiz'), null);
    assert.equal(activeTabHref('/attribution'), null);
  });

  it('does not treat a lookalike prefix as Explain', () => {
    assert.equal(activeTabHref('/explainer'), null);
  });

  it('leaves the sidebar and the drawer on the longest-match rule', () => {
    assert.equal(activeNavigationHref('/explanations'), '/explanations');
    assert.equal(activeNavigationHref('/explanations/abc-123'), '/explanations');
    assert.equal(activeNavigationHref('/explain'), '/explain');
  });
});
