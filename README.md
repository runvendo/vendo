<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <img src="assets/banner-light.svg" alt="Vendo: your product, shaped to every customer" width="100%">
</picture>

<p align="center">
  <b>Vendo puts an agent inside your product.</b><br>
  Customers automate work, build their own views, and connect their tools. You set the guardrails.
</p>

<p align="center">
  <a href="https://vendo.run">Website</a>
  &nbsp;·&nbsp;
  <a href="https://docs.vendo.run">Docs</a>
  &nbsp;·&nbsp;
  <a href="docs/quickstart.md">Quickstart</a>
  &nbsp;·&nbsp;
  <a href="#see-it-in-action">Demos</a>
</p>

```bash
npx vendoai init .
```

<br>

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
    <td colspan="2" align="center">
      <img src="assets/automation.gif" alt="A Cadence user asks for a morning document-chase automation and turns it on with per-tool approvals" width="48%">
      <p align="center"><sub><b>Automate across tools.</b> Plain language in, standing automation out, every tool gated by approval.</sub></p>
    </td>
  </tr>
</table>

## Why Vendo

Every customer wants your product to be a little different. A rearranged
dashboard, a missing report, a workflow they repeat by hand every morning.
Today those wishes die in a feature-request queue. Vendo turns them into
things customers do themselves, safely, inside your product.

It is not a chatbot bolted onto your app. The agent works through the same
API and components you already ship, renders in your brand, and never steps
outside your permission policy.

## What it does

| | |
|---|---|
| **Views on demand** | Customers describe what they want to see. The agent composes it from your component catalog and live API data, rendered in your brand. |
| **Remix** | Any component you wrap becomes customer-editable in place. Changes are scoped to that customer and reversible. |
| **Automations** | Standing workflows from plain language, run on schedules or triggers, durable across restarts. |
| **Integrations** | Gmail, Slack, Calendar, and any MCP server, each behind per-tool consent. |
| **Guardrails** | Generated UI runs in a sandboxed iframe with no network egress. Every mutating action passes your permission policy: consent prompts, approval tokens, judged rules. |
| **Any provider** | Bring your own key for Anthropic, OpenAI, or Google. Works with any AI SDK provider. |

## Get started

1. Install into your Next.js app:

   ```bash
   npx vendoai init .
   ```

   The command extracts your theme, derives agent tools from your OpenAPI
   spec, and wires the routes.

2. Add one provider key to `.env.local`: `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`.

3. Start your dev server. The Vendo surface is live in your product.

<p align="center">
  <img src="assets/init.gif" alt="vendo init running against a real Next.js app: theme extracted, tools derived from the OpenAPI spec, components wrapped, routes wired" width="100%">
</p>
<p align="center"><sub>A real <code>vendo init</code> run: theme extracted from your CSS, 17 agent tools derived from the app's OpenAPI spec, 11 components wrapped for generated UI, routes wired.</sub></p>

Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

Want to try it before integrating? `pnpm demo` runs Maple, a demo bank with
Vendo embedded. `pnpm demo:accounting` runs Cadence, an accounting firm app
with remix, automations, and voice.

## How it works

The agent acts through your product's OpenAPI surface as the signed-in user.
Generated UI renders in a sandboxed iframe with no network egress, and host
components render natively from your catalog. Every mutating action flows
through your permission policy. Deeper docs: [docs/](docs/).

<details>
<summary><b>Packages</b></summary>

| Package | What it is |
|---|---|
| `vendoai` | The public install (interim name; bare `vendo` pending an npm name-dispute) — `vendoai/server` (`createVendoHandler`) + `vendoai/react` (`<VendoRoot>`) |
| `@vendoai/cli` | `vendo init`, a one-command install into a Next.js app |
| `@vendoai/core` | Manifest schemas, GenUI format, the five platform seams |
| `@vendoai/server` | Provider-agnostic agent server (bring any AI SDK provider) |
| `@vendoai/runtime` | Embedded runtime: tools, automations, MCP client |
| `@vendoai/react` | React provider + `useVendoChat` |
| `@vendoai/shell` | The embedded surfaces: tabbed page, overlay, slot |
| `@vendoai/components` | Brand-themeable component catalog |
| `@vendoai/stage` | Sandboxed stage runtime and bridge for generated UI |
| `@vendoai/store` | Durable persistence (PGlite default, Postgres in prod) |
| `@vendoai/telemetry` | Anonymous, opt-out build/dev telemetry |

</details>

## FAQ

<details>
<summary><b>Is customer data safe?</b></summary>
<br>Generated UI runs in a sandboxed iframe with no network egress. The agent acts through your API as the signed-in user, so your existing authorization applies. Nothing leaves your infrastructure except calls to the model provider key you configure.
</details>

<details>
<summary><b>Do I need a Vendo account?</b></summary>
<br>No. Vendo is open source and self-hosted. You bring a provider API key. No signup, no hosted dependency, and no telemetry on end users.
</details>

<details>
<summary><b>What does it cost?</b></summary>
<br>The code is Apache-2.0 and free. You pay your model provider for the tokens your customers use.
</details>

<details>
<summary><b>Which frameworks are supported?</b></summary>
<br>Next.js App Router today via the <code>vendoai</code> package's ready-made route pair. The agent server is a plain fetch handler underneath (plus a Node adapter for Express/<code>node:http</code>), so other frameworks can wire it manually.
</details>

<details>
<summary><b>How does it match my brand?</b></summary>
<br><code>vendo init</code> extracts design tokens from your app, and generated UI composes your own wrapped components plus a themeable catalog.
</details>

---

PRs welcome: [CONTRIBUTING.md](CONTRIBUTING.md) · telemetry: [TELEMETRY.md](TELEMETRY.md) ·
security reports: [SECURITY.md](SECURITY.md) · [Apache-2.0](LICENSE)
