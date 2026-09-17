---
name: search-panes-card-recipe-must-stay-a-literal
description: the two translator cards' class list is read as a literal by a unit test, so a conditional class goes on a wrapper, never folded into it
metadata:
  type: project
---

`tests/unit/search-panes-language-bar.test.ts` extracts `className="..."`
LITERALS from `app/components/search-panes.tsx` and asserts exactly two of them
contain `rounded-2xl` and that the two are identical.

**Why:** the input card and the answer card are one control and its reply, and
the test is what keeps them from drifting apart (DESIGN.md section 3).

**How to apply:** any state-dependent class on the answer card, the stale-answer
`pulse-soft opacity-60` for instance, goes on a WRAPPER div around it. Folding it
into the card's own `className` as a template literal makes the check unable to
see either card, so the rule passes vacuously instead of failing.

Related: [[project_search_tsx_has_source_grep_tests]].
