# @vendoai/engine

A thin, command-agnostic runner around `@anthropic-ai/claude-agent-sdk`: a
job goes in on stdin, the agent's final message text comes out on stdout.
No init logic, no Vendo-specific prompts or schemas — those all live in the
caller (`vendo`'s init/extract ladder).

This package is **not** a dependency of any `@vendoai/*` package. It exists
so that init's last-resort engine rung can run:

```sh
npm exec @vendoai/engine@<pinned-version> -- run
```

without ever installing the Agent SDK's ~245MB bundled Claude Code binary
into a host app's `node_modules`. `npm exec` fetches and caches it on the
dev's machine on first use only.

## Contract

- stdin: a job JSON object — `{ "instructions": string, "root": string }`.
- Credentials: `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN` (+ optional `ANTHROPIC_CUSTOM_HEADERS`) — read
  directly from the process environment, passed through untouched.
- stdout: exactly the agent's final message text. Nothing else.
- stderr: progress narration (tool use, intermediate assistant text).
- Exit code: `0` on success, non-zero on any failure (bad job, engine error).

Tool policy is read-only (`Read`/`Glob`/`Grep`) rooted at `job.root`, and the
session's `settingSources` are isolated (`[]`) so the dev's personal Claude
Code settings/hooks never leak into the run.

## Why zod ^4 here only

`@anthropic-ai/claude-agent-sdk` peer-requires `zod ^4.0.0`. The rest of the
workspace pins zod 3.x for its `ai`-SDK peers (see
`scripts/dependency-guard.mjs` rule 4). This package declares its own zod ^4
dependency to satisfy that peer in its own dependency subtree; pnpm resolves
it as a separate instance scoped to this package (already precedented in the
workspace lockfile via `@mastra/schema-compat`'s zod-3/zod-4 dual instances),
so it does not affect any other package's zod resolution.
