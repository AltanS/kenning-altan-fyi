---
name: project-clipboard-has-a-fallback-port
description: navigator.clipboard is undefined on the plain-http dev origin, so copy goes through app/lib/copy-text.ts, a port whose choice is unit-testable without a DOM
metadata:
  type: project
---

`app/lib/copy-text.ts` is the one way a string reaches the clipboard.
`copyTextWith(text, port)` is a pure choice over a `ClipboardPort`
(`writeText | null` plus `copyBySelection`), `browserClipboard()` is the only
thing that touches a `document`, and `copyText(text)` joins the two. It never
throws: it answers `true` or `false`.

**Why:** `navigator.clipboard` exists only in a secure context, so on
`http://bluefin:3210` (the dev server from a phone) it is undefined.
`CopyTextButton` used to probe it in a mount effect and render itself
`disabled`, which made every copy control on `/explanations/:id` and the answer
card permanently dead with nothing saying why. The hidden-textarea plus
`document.execCommand('copy')` path still works on exactly those origins. The
port exists because this repo's unit tier has no DOM, and a fallback that is
never reached is the same as no fallback.

**How to apply:** a new copy control calls `copyText` and reports the boolean;
disable it only on an empty string. Test the CHOICE through `copyTextWith` with
a fake port (`tests/unit/copy-text.test.ts`); the fallback's own DOM steps are
deliberately uncovered. This retires the probe half of
[[project_translate_env_probe_needs_a_mount_effect]], whose hydration rule
still stands for every other browser-environment read.
