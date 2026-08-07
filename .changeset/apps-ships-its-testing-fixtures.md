---
"@vendoai/apps": minor
---

`@vendoai/apps` now ships its testing fixtures at the `./testing` subpath. The directory (`fake-sandbox`, `fake-box`, `scriptedLanguageModel`, `guardFixture`, `memoryStore`, and the rest) was already compiled into `dist/testing/` and already inside the published `dist` files-entry, but no `exports` key pointed at it, so it was dead weight in the tarball and unreachable to anyone — including this repo's own fixture suites, one of which carries the comment "the apps package's own test double is internal to that package" as the reason it hand-rolled a fortieth copy of a scripted model. Same posture as the `./adapter-conformance` subpath this package already publishes: testing material a host can use against the seams it implements. Purely additive — no existing subpath, type, or runtime behaviour changes.
