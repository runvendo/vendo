<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <img src="assets/banner-light.svg" alt="Vendo: your product, shaped to every customer" width="100%">
</picture>

<p align="center">
  <b>Vendo puts an agent inside your product.</b><br>
  Customers can build views, act through your APIs, and automate work inside your brand and guardrails.
</p>

<p align="center">
  <a href="https://vendo.run">Website</a>
  &nbsp;·&nbsp;
  <a href="https://docs.vendo.run">Docs</a>
  &nbsp;·&nbsp;
  <a href="https://docs.vendo.run/quickstart">Quickstart</a>
</p>

```bash
npm install @vendoai/vendo
npx vendo init
```

`@vendoai/vendo` is the default composition. The `vendoai` package is a thin
alias. Install individual blocks when you want to compose Vendo yourself.

## What Vendo does

- Runs a streaming agent with any AI SDK `LanguageModel`.
- Extracts your API as tools and executes present calls with the signed-in user's session.
- Builds user-owned apps from a format-tagged UI document, escalating to a sandboxed server only when needed.
- Applies policy, approvals, grants, breakers, and audit at one execution choke point.
- Runs scheduled, host-event, and external-trigger automations with app-bound grants.
- Ships headless hooks plus optional, theme-driven React chrome.

PGlite at `.vendo/data` is the zero-config store. Production uses the same
schema on Postgres. Generated components run in an iframe jail with
`connect-src 'none'`. App machines reach host tools only through the guarded
tool proxy.

## Packages

| Package | One job |
| --- | --- |
| `@vendoai/core` | Shared types, schemas, formats, validators, and seams |
| `@vendoai/store` | Postgres persistence, with PGlite as the default |
| `@vendoai/agent` | Conversation loop, streaming, tools, and thread context |
| `@vendoai/actions` | Host API and connector tools executed as the signed-in user |
| `@vendoai/guard` | Policy, approvals, grants, audit, breakers, and safety |
| `@vendoai/apps` | App generation, editing, execution, interchange, and sandbox adapters |
| `@vendoai/automations` | Trigger ingestion, schedules, away runs, and run history |
| `@vendoai/ui` | Headless React hooks, optional chrome, tree rendering, and voice surfaces |
| `@vendoai/telemetry` | Anonymous, opt-out build and development telemetry |
| `@vendoai/vendo` | Default composition, public wire, React entry, and `vendo` bin |

## Install flow

`vendo init` scans the host app, interviews you about risk labels, theme, and
remix candidates, then proposes the handler route and `<VendoRoot>` wiring.
Every code change is permission-gated and shown as a diff. It writes the
reviewable `.vendo/` directory and leaves the PGlite data directory ignored.

Run `vendo doctor` to check wiring and probe `/status`. Run `vendo sync` in
build and development flows to refresh extracted tools and remix baselines.

Read the [quickstart](https://docs.vendo.run/quickstart) for the complete
composition and first-turn setup.

## License

Apache-2.0. Cloud-gated sharing, publishing, org overlays, and pinning activate
with `VENDO_API_KEY`; the open-source blocks remain self-hosted.
