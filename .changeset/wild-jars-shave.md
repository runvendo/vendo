---
"@vendoai/vendo": minor
---

Delete `@vendoai/engine`; init's `--engine npx` rung now fetches Anthropic's
published `@anthropic-ai/claude-code` instead.

The rung's user-facing behaviour is unchanged — last resort, one-time ~250MB
`npm exec` fetch disclosed before it starts, read-only Read/Glob/Grep over the
host root, own credential or the Vendo Cloud gateway — but it now spawns the
same binary as the PATH rung rather than a Vendo-published wrapper around the
Agent SDK. The credential label reads "via npm-fetched Claude Code" instead of
"via the Vendo engine".

The engine's path-confinement guard moves up to the ladder level
(`cli/extract/confine-to-root.ts`) and now covers every Claude rung, in the two
forms those rungs can enforce:

- The Agent SDK rung wires `confineToolToRoot` as its `canUseTool` callback, so
  a prompt-injected `Read ~/.aws/credentials` is denied there too. It passes
  `tools` rather than `allowedTools`, because a blanket allowlist auto-allows
  and never consults the callback.
- The two CLI rungs — the `claude` binary on PATH and the npm-fetched one —
  have no callback to hand a subprocess, so they now pass root-scoped
  permission rules (`Read(//<root>/**)` and friends) instead of the bare tool
  names they used to. A bare `Read` on `--allowedTools` is the CLI's own
  version of the blanket auto-allow: it permits Read on ANY path. Both rungs
  previously let a repo-derived prompt ("the config lives at
  `../outside/secret.txt`") read outside the extraction root and hand the
  contents to the model provider; the CLI matches these rules against both the
  path the model supplied and the path it resolves to, so a `..` climb and an
  in-root symlink pointing outside are each denied.
