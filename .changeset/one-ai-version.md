---
"@vendoai/agent": patch
"@vendoai/apps": patch
"@vendoai/core": patch
"@vendoai/guard": patch
"@vendoai/harnesses": patch
"@vendoai/knowledge": patch
"@vendoai/store": patch
"@vendoai/ui": patch
"@vendoai/vendo": patch
---

One `ai` version across the monorepo, and one installed copy of it.

Every block pinned `ai@6.0.28` while `examples/mastra-agent` pinned `6.0.230`
and `@ai-sdk/react@3.0.230` carried its own `6.0.228`, so three copies of the
ai SDK were installed and the engine compiled against a pin roughly 200
patches behind the v6 head. All of them now resolve to `ai@6.0.242`, and
`@ai-sdk/react` moves to `3.0.244`, whose own `ai` dependency is exactly
`6.0.242` — that is what collapses the third copy rather than merely hiding it.

What a host may notice:

- **`ai` stays a peer dependency, and the range is unchanged**
  (`>=6.0.0 <7`). The host still owns the install, React-style: one
  `LanguageModel` seam, one SDK instance. Only the pinned devDependency the
  blocks compile and test against moved, so a host on any `6.x` is unaffected.
- **`@vendoai/ui`'s peer range was `^6.0.0`** where every sibling declared
  `>=6.0.0 <7`. Semantically the same for v6, but it now reads the same as the
  rest.
- **`@vendoai/store` declares `ai` for the first time.** It imported
  `UIMessage` from `"ai"` in two test files and declared no `ai` at all. The
  tests are excluded from its build, so the published `dist` never reaches for
  `ai`; a pinned devDependency is the whole fix and no new peer appears on the
  package.
