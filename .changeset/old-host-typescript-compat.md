---
"@vendoai/actions": patch
"@vendoai/vendo": patch
---

Feature detect the TS 4.8 modifier APIs and TS 4.9 `isSatisfiesExpression` in static extraction, falling back to the legacy node properties, so `vendo init` no longer crashes on hosts whose own TypeScript predates those APIs (#551).
