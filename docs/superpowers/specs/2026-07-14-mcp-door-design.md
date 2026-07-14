# Ship through the MCP door — project design

**Date:** 2026-07-14
**Linear:** [Ship through the MCP door](https://linear.app/runvendo/project/ship-through-the-mcp-door-98acd75fb57f)
**Status:** Approved by Yousef (brainstorm 2026-07-14). Grounded by four examination
reports (door code, OAuth server, app format/rendering, MCP ecosystem landscape).

## Outcome

"One flag to ship: `mcp: true` → product installable in Claude/ChatGPT/Cursor with
OAuth, tool serving, MCP Apps rendering handled" — plus discovery and a hosted
broker. Agent-reachability becomes distribution.

**Finish line — a GIF matrix, not a test suite:**

- Maple and a deployed Umami fork install as MCP servers in Claude.ai (custom
  connector), ChatGPT (developer mode / workspace app), and Cursor (deeplink),
  each captured as a real demo GIF: install → OAuth → consent → tool call →
  approval park → resolve in product.
- Branded Vendo tree apps render and respond inside Claude and ChatGPT.
- Maple is discoverable on the official MCP registry under the vendo.run
  namespace.
- One product connects end-to-end through a working Vendo-hosted broker.

## Grounding: where the code actually is

The examination found the door far beyond "harden": `packages/mcp` ships a
complete streamable-HTTP door with OAuth 2.1 (PKCE, DCR, CIMD), RFC 8414/9728/8707
metadata, hashed-at-rest tokens, refresh rotation with reuse-revocation,
replay-safe approvals, a real-SDK e2e suite, and an already-built MCP Apps shim.
The gaps are shipping gaps:

1. No shipping host opens the door — no `mcp: true` outside test fixtures, no
   real `HostOAuthAdapter`, no consent UX anywhere.
2. The MCP Apps shim is untested at runtime, unbranded (theme does not cross the
   boundary), can't render http/rung-4 apps, and its generated-component jail
   (triple-nested iframe inside a host client) is unverified.
3. The corpus pack list is missing `@vendoai/mcp`, which the umbrella
   hard-depends on — corpus installs of the umbrella are broken.
4. Smaller: no RFC 7009 revocation endpoint (revocation is all-sessions, not
   per-client), `scopes_supported` blank, multi-instance token-redemption race
   (in-process lock only), Next.js hosts must hand-write sibling `.well-known`
   routes, `docs/contracts/00-overview.md` still calls mcp "deferred entirely."

## Locked decisions (from the brainstorm)

| Decision | Choice |
| --- | --- |
| Scope | All four pillars: harden door+OAuth, discovery, MCP Apps rendering, hosted broker |
| Flagship clients | Claude.ai **and** ChatGPT (Cursor also in the GIF matrix) |
| Protocol version | Ship on 2025-11-25; structure session/replay state so the 2026-07-28 stateless spec is an adapter away; adopting 07-28 is a tracked follow-up |
| Demo hosts | Maple + a **fork of Umami** (real `vendo init` on a repo we didn't write), both deployed to Railway with a public URL; tunnel for iteration |
| Distribution bar | Custom-connector installs + official MCP registry listing. Claude/ChatGPT **directory submissions are follow-ups, not gates** (they depend on org accounts and review queues) |
| Apps rendering bar | Tree apps render **branded** (theme crosses the boundary); jail verified in real clients; http/rung-4 apps degrade to an open-in-product card. Full http rendering deferred |
| Consent UX | The door ships a **prebuilt, themeable consent/login-bounce page**; the host supplies only its session lookup and may replace the page |
| Broker | Working MVP, **Cloud-paid**, lives in **vendo-web** (`services/broker`), deployed on Railway, gated by hand-issued `VENDO_API_KEY`, no billing yet |
| Broker architecture | Broker-hosted authorization server (DCR/CIMD, consent, token custody, revocation) with **login federated back to the customer's product** via a signed-callback seam; the customer's door validates broker-issued tokens (introspection/JWKS). OSS repo ships the open half of the seam |
| Execution | Four child Orca sessions (Fable orchestrators; codex sol executes, Opus 4.8 only when sol is blocked), owned and monitored by the parent session |

## Workstreams

### A — Door-to-demo (OSS repo) — starts first, everything demos through it

- Fix the corpus pack list (`@vendoai/mcp` + README) — confirmed
  umbrella-breaking, first commit of the project.
- Ship the prebuilt themeable consent/login-bounce page in the door package.
  Kills the interactive-consent infinite-loop footgun; keeps `mcp: true` one flag.
- Wire Maple: `mcp: true`, real `HostOAuthAdapter` over its demo auth, consent
  page, deployed + tunneled.
- Fork and wire Umami the way a customer would: real `vendo init`, `mcp: true`,
  consent, deployed on Railway.
- Hardening backlog: RFC 7009 revocation endpoint + per-client session kill;
  store-level atomic token claim (fixes the multi-instance race; broker
  prerequisite); stateless-ready refactor of session/replay state;
  init-generated Next.js sibling `.well-known` route; `scopes_supported`;
  reconcile the stale `00-overview.md` line.
- GIFs: the full install journey on Claude.ai, ChatGPT, and Cursor for both hosts.

### B — Apps ride along (OSS repo) — shim/theme work starts in parallel; real-client proof consumes A's hosts

- Theme tokens cross the MCP boundary: unify the shim's CSS variable namespace
  with the pipeline's `--vendo-*` tokens and deliver the host's extracted theme
  into the shim and the jail. Brand-native inside Claude.
- Shim runtime test suite (currently near-zero coverage) + the contract-mandated
  real-MCP-client apps-ride-along e2e, including the live-Claude leg.
- Verify the generated-component jail (nested iframes + CSP + eval) survives
  real Claude/ChatGPT sandboxing — the highest-uncertainty item; browser-proven.
  If a client's sandbox forbids it, that finding comes back as a scope decision.
- http/rung-4 apps degrade to a graceful open-in-product card instead of
  "Invalid app result".
- De-duplicate query resolution (server-resolved payloads must not re-resolve in
  the shim).
- GIFs: a branded tree app rendered and interacted with inside Claude and
  ChatGPT, including an approval round-trip.

### C — Discovery (OSS repo + registry) — tooling parallel; publishing consumes A's deployed Maple

- `vendo` CLI/init/doctor generate `server.json` and wire the `.well-known`
  surface; doctor validates it live.
- Documented customer publish flow: reverse-DNS namespacing, DNS-TXT
  verification, registry submission.
- Publish the deployed Maple to the official MCP registry under vendo.run.
- Server card stays provisional, tracking SEP-2127 as it moves.
- GIF: discovery → install.

### D — Broker MVP (vendo-web, private, Cloud-paid) — design first, independent until e2e

- `services/broker` in vendo-web, deployed to Railway: stable `*.mcp.vendo.run`
  URLs fronting customer doors; broker-hosted AS per the locked architecture.
- OSS-side seams land in the vendo repo: signed login-federation callback and a
  remote-AS trust mode for the door.
- Child session opens with its own design doc (token custody is a real trust
  surface) reviewed by Yousef before build.
- e2e: one host (Maple or the Umami fork) connected through the broker; GIF.

## Dependencies

A unblocks everything user-visible. B and C begin on fixture-testable ground
immediately and consume A's deployed hosts for real-client proof. D designs
immediately, builds against A's atomic-claim and federation seams, and runs its
e2e against A's hosts.

## Quality bar

Every workstream ends with real captured GIFs of real clients — unit tests and
typecheck alone don't count. `pnpm build && pnpm test && pnpm typecheck && pnpm
lint` green before any PR; UI-affecting changes browser-verified; no commits to
main; child sessions inherit this bar verbatim.

## External prerequisites and risks

- Yousef's accounts: ChatGPT with developer mode (OpenAI business verification
  only if we later pursue the app directory), Claude.ai, vendo.run DNS access.
- The official registry is still "preview" — data resets are theoretically
  possible; re-publishing is cheap.
- The 2026-07-28 spec is an RC and could shift; we ship 2025-11-25 regardless.
- Jail-inside-real-client is genuinely unknown; workstream B surfaces the
  finding before committing to a rendering promise.
- Umami fork is MIT-licensed — fine to fork and deploy publicly.

## Out of scope (tracked as follow-ups, not gates)

- Claude Connectors Directory and ChatGPT app directory submissions.
- Full http/rung-4 app rendering inside host clients.
- MCP Apps write-back beyond `call`; scope-granular consent.
- Broker billing/self-serve signup (separate project; MVP is key-gated).
- Adopting protocol 2026-07-28 (follow-up issue once clients ship it).
