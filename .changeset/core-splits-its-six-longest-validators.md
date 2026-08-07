---
"@vendoai/core": patch
---

Internal refactor: core's six highest-cognitive-complexity functions are decomposed into named helpers. `applyStep` and `reshapeShape` (reshape.ts) each split one branch per reshape op; `validateAppDocumentUnsafe` (app-document.ts) splits one function per cross-field rule; `validateTreeUnsafe` (genui/tree.ts) splits the query block and the node walk; `parseAttributes` (genui/wire/attributes.ts) splits the `=`-value forms and the duplicate-attribute message; `prescanDeclarations` (genui/wire/compile.ts) splits the `<Query>` and `<Island>` pre-scan branches. Every extracted helper is module-private and every message, order of checks and return value is unchanged. **No public surface changed** — not one exported symbol, signature or type moved, and no test file was touched.
