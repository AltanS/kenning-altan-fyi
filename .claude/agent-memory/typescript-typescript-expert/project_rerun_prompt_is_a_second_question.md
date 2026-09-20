---
name: rerun-prompt-is-a-second-question
description: A translation re-run needs prompt v3, a PROMPT_VERSION bump and a rerunReason in the payload, because the singleton key and the identical prompt would otherwise both defeat it
metadata:
  type: project
---

A re-translation is only reachable if THREE things change together, and each one
alone is inert.

**Why:** the reader's complaint is an INCOMPLETE answer, not a wrong one. A
second call to the identical prompt returns the identical words. And
`translationSingletonKey` carries `promptVersion`, so under the old version the
re-run could collide with the run that produced the answer being rejected.

**How to apply:** when adding a re-run to any of the three sibling pipelines
(word, phrase, explain):

1. `app/prompts/translation/v3.md` holds `{{situation}}` (the second sentence of
   paragraph 2, which used to assert "the dictionary has no translation for it
   yet") and `{{revision}}`. `{{revision}}` sits ALONE on the line between the
   limits and the rules, and its block carries its own leading and trailing
   newline, so the empty case renders byte-identically to v2.
2. `PROMPT_VERSION` 2 to 3. The bump is what makes the key free, not bookkeeping
   about a reworded file.
3. `rerunReason: z.enum(REJECTION_REASONS).nullable().default(null)` on the
   payload. `translationSingletonKey` stays UNCHANGED: two readers rejecting one
   word ride one re-run.

The revision block's `{{toLanguageName}}` must be resolved BEFORE the block goes
into the template, exactly as `TASKS.authorSenses` handles
`{{fromLanguageName}}`. The substitution pass has already run over the template
by then, so the guard would never see it. See [[translate-writer-already-upserts]].
