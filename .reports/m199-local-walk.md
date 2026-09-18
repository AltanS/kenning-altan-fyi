# M199 local walk — 2026-09-18

Run against `http://localhost:3210`, signed in as `user@example.com`, one quiet dev server (no concurrent file-editing agent), headless Chromium via agent-browser.

1. PASS — Sign in, open `/settings`, set public name "M199 Probe", save. Toast "Public name saved.", field shows the name, Clear enables.
2. PASS — Reload. Name field still reads "M199 Probe" — persisted server-side, not held only in client state.
3. PASS — Toggle "Hide new explanations by default" on. Toast "Setting saved.", `aria-checked="true"`. Reload: still `true`.
4. PASS — Clear the public name. Reload: name field is empty, Clear is disabled, and the default-visibility switch is still `checked=true` — clearing the name did not delete the row or reset the unrelated preference.
5. PASS — Toggle the switch back off. Reload: `aria-checked="false"` — clean end state.
6. PASS — On `/explain`, asked a novel question ("What does the phrase m199-probe-walk-unique-9f3k mean in this context", en→de) never seen by this database before. It queued, generated, and rendered a normal answer with the existing Copy/Generated controls — no new field, no new control, nothing on this screen changed by this milestone. Confirms the enqueue-result fix (spec 01) has no browser-observable surface, as its own spec states.

Environment note: headless Chromium (both the bundled `chrome` and `chrome-headless-shell` builds) crashed with a FATAL `SkFontMgr_FontConfigInterface` error on this host when resolving the system default variable sans-serif font. Worked around for this walk only with a minimal `FONTCONFIG_FILE` pointing at static (non-variable) Liberation fonts; no application code or configuration was touched to achieve this — it is purely local automation tooling, same root cause as this repo's own `Headless Chrome is not a faithful renderer` note.
