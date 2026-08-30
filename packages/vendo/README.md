# @vendoai/vendo

Vendo puts an agent inside your product. Customers can build views, act through
your APIs, and automate work inside your brand and guardrails.

```bash
npm install @vendoai/vendo
npx vendo init
```

This is the default composition: the public wire handler, React provider,
policy-bound agent and app blocks, persistence, the MCP door — and the `vendo`
CLI, whose bin this package installs. One install is the whole surface; reach
for individual `@vendoai/*` blocks only when you want to compose Vendo
yourself.

Vendo extracts host APIs as signed-in-user tools, renders theme-driven React
surfaces, applies approvals and audit at one execution choke point, and uses
PGlite locally with the same schema on production Postgres. The store runtime
(`createStore`, `envSecrets`, `storeSecrets`, `secretStore`) is re-exported
from `@vendoai/vendo/server` for production deploys.

The composed agent reads `.vendo/brief.md` and the component catalog + theme
into its system prompt, cancels a turn when the client disconnects, and caps
tool steps per turn via `agent.maxSteps` (default 20) with a visible
step-limit notice in the stream.

This package also ships the standalone backend agent — `agent()`, `tool()`,
`api()`, `serve()` and `agentHandler`, with `session()`, `respond()`, `run()`
and `chat()` on the agent it builds. That path takes none of the CLI or UI
above — an empty Node project and one import. It arrived here when
`@vendoai/agents` folded in, and every export kept its name.

Read the [quickstart](https://docs.vendo.run/quickstart), the
[backend quickstart](https://docs.vendo.run/backend/quickstart) and the
[CLI reference](https://docs.vendo.run/reference/cli).
