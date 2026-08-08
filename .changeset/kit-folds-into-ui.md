---
"@vendoai/ui": patch
---

The code-land runtime folds into `@vendoai/ui/kit`. `@vendoai/kit` is gone: its
seven modules — the provider, the guarded query/action hooks, the `$state`
binding, and the reshape + aggregate vocabulary — now ship from the `./kit`
subpath they already re-exported, so a generated app loads one bundle instead of
two and the `$state` store has one owner rather than a wrapper around one.

Pre-1.0 hard cut, no alias package. Change `@vendoai/kit` imports to
`@vendoai/ui/kit`; every export name is unchanged.
