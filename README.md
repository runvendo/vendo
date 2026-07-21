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

## Install with your coding agent

Paste this inside your app's repo:

<!-- Canonical prompt text: vendo-web lib/prompts.ts (mirrored by the docs
     AgentPrompt cards). Change it there first. -->

```text
Install Vendo in this repo. Read https://vendo.run/agents.md and follow
it exactly. Ask me before creating any account or key. You're done when
`vendo doctor --json` reports all green. Then ask me whether I'd like to
star it via https://vendo.run/star?src=readme to support the project.
```

The playbook behind that URL walks the agent through detection, `vendo init`
value flags, host-auth wiring, and the `vendo doctor --json` gate, where every
error code links to its exact fix. Already have an agent (AI SDK or Mastra)?
Use the prompt on [existing agents](https://docs.vendo.run/existing-agents.md)
instead — it adds Vendo's guarded tools to your loop without replacing it.

`@vendoai/vendo` is the default composition. The `vendoai` package is a thin
alias. Install individual blocks when you want to compose Vendo yourself.

## See it in action

Every capture below is a real agent run in a demo host app, not a mockup.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/hero.gif" alt="A Maple customer asks where their money went and the agent composes a live spending view" width="100%">
      <p align="center"><sub><b>Build views.</b> Ask a question, get a live view composed from the host's own components and API.</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="assets/remix.gif" alt="A Cadence user hovers the deadlines card, asks for urgency color-coding, and applies the remix in place" width="100%">
      <p align="center"><sub><b>Remix the UI.</b> Hover a component, describe the change, apply it in place.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/automation.gif" alt="A Cadence user asks for a morning document-chase automation and turns it on with per-tool approvals" width="100%">
      <p align="center"><sub><b>Automate across tools.</b> Plain language in, standing automation out, every tool gated by approval.</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="assets/voice.gif" alt="A Maple voice session: the user asks out loud where their money went and the agent renders the view while talking back" width="100%">
      <p align="center"><sub><b>Talk to it.</b> A live voice session: ask out loud, the agent talks back and renders the view.</sub></p>
    </td>
  </tr>
</table>

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
| `@vendoai/mcp` | The door: serves the host's tools to outside MCP clients |
| `@vendoai/telemetry` | Anonymous, opt-out build and development telemetry |
| `@vendoai/vendo` | Default composition, public wire, React entry, and `vendo` bin |

## Install flow

`vendo init` scans the host app, then asks about the model import, product brief,
critical-tool risk labels, and whether to open the MCP door. It proposes the
handler route and `<VendoRoot>` wiring while extracting the theme automatically.
Every code change is permission-gated and shown as a diff. It writes the
reviewable `.vendo/` directory and leaves the PGlite data directory ignored.

Run `vendo doctor` to check wiring and probe `/status`. Run `vendo sync` in
build and development flows to refresh extracted tools and remix baselines.

Agents get the same journey machine-readable: the playbook at
[vendo.run/agents.md](https://vendo.run/agents.md) (with
[llms.txt](https://docs.vendo.run/llms.txt) indexing every docs page),
`vendo init --agent` for a read-only JSON plan carrying extracted tools and
risk recommendations, `vendo sync --json`, and a `vendo-setup` skill shipped
inside the npm tarball that init offers to write into `.claude/skills/`.

Read the [quickstart](https://docs.vendo.run/quickstart) for the complete
composition and first-turn setup.

## License

Apache-2.0. Cloud-gated sharing, publishing, org overlays, and pinning activate
with `VENDO_API_KEY`; the open-source blocks remain self-hosted.
