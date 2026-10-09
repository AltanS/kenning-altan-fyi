---
name: root-tsx-is-testable-with-a-loader-hook
description: To import app/root.tsx (or any route importing css) in a node:test, register tests/support/stub-assets-hooks.mjs; mock.module cannot mock a .css specifier
metadata:
  type: project
---

`mock.module('@fontsource-variable/inter', ...)` and a mock of `./app.css?url` both still fail with `ERR_UNKNOWN_FILE_EXTENSION`, because the mock loader calls `nextLoad` on the resolved `.css` URL to learn its format.

**How to apply:** at the top of the test, `register('../support/stub-assets-hooks.mjs', import.meta.url)` (from `node:module`), then `mock.module` the three server-only imports of root (`#app/middleware/auth`, `#app/utils/toast.server`, `#app/middleware/session-renewal`), then `await import('#app/root')`. `tests/unit/root-offline-fallback-flag.test.ts` is the worked example. Each test file is its own process, so the hook does not leak.

The loader's answer is typed with `headers: Headers` while `clientLoader`'s `serverLoader` expects the serialized all-undefined shape, so pass the stub args with `as never` plus a `// SAFETY:` comment.
