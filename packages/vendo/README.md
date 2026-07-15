# @vendoai/vendo

Vendo puts an agent inside your product. Customers can build views, act through
your APIs, and automate work inside your brand and guardrails.

```bash
npm install @vendoai/vendo
npx vendo init
```

This is the default composition: the public wire handler, React provider,
policy-bound agent and app blocks, persistence, MCP door, and the `vendo` CLI.
Install individual `@vendoai/*` blocks only when you want to compose Vendo
yourself.

Vendo extracts host APIs as signed-in-user tools, renders theme-driven React
surfaces, applies approvals and audit at one execution choke point, and uses
PGlite locally with the same schema on production Postgres.

Read the [quickstart](https://docs.vendo.run/quickstart) and
[CLI reference](https://docs.vendo.run/reference/cli).
