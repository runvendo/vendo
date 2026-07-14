# Workstream C — Discovery: Implementation Plan

> **For agentic workers:** Execute task-by-task; each task is one Linear issue,
> one branch, one PR. Quality bar from the project spec applies verbatim:
> `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green, no commits to
> main, real-client proof (GIF) for the finish line.

**Goal:** A Vendo host can generate its official-MCP-registry listing artifacts
from its own config, validate them live with `vendo doctor`, follow a documented
publish flow, and we prove it end-to-end by publishing the deployed Maple demo
under the vendo.run namespace.

**Spec:** `docs/superpowers/specs/2026-07-14-mcp-door-design.md` (workstream C).
**Linear:** ENG-280 (tooling), ENG-281 (docs), ENG-282 (Maple publish + GIF).

---

## Research facts (verified 2026-07-14, official registry docs)

- The official registry (registry.modelcontextprotocol.io) is still **preview**;
  data resets possible; republishing is cheap and acceptable.
- Current `server.json` schema: **2025-12-11**
  (static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
  Required: `name` (reverse-DNS, e.g. `run.vendo/maple`), `version`, and at
  least one of `packages`/`remotes`. Remote hosts use a `remotes` entry of type
  `streamable-http` with the door's public URL. `websiteUrl` points users at
  setup docs.
- Domain-namespace authentication (what a Vendo customer uses): reverse-DNS
  name under their domain, proven by **either** a DNS TXT record at the apex
  (`v=MCPv1; k=ed25519; p=<base64 public key>`) **or** an HTTPS challenge file
  at `/.well-known/mcp-registry-auth` with the same content. Login via the
  `mcp-publisher` CLI (`login dns` / `login http`), then `mcp-publisher publish`.
- **Namespace/URL binding:** for a `run.vendo/*` name, the remote URL must be on
  vendo.run or a subdomain. Consequence: the deployed Maple must be fronted by a
  vendo.run subdomain (e.g. `maple.vendo.run`) — a bare Railway URL is not
  publishable under our namespace. Escalated to the parent/workstream A.
- SEP-2127 (server cards) is still **Draft** with an active working group; the
  door's existing `/.well-known/mcp/server-card.json` (+ alias) matches the
  current consensus path. It stays provisional; no path change until
  ratification (contract 10-mcp §5 already says this).

## Where the code stands today

- `packages/mcp/src/door.ts` already serves the OAuth discovery documents and
  the provisional server card; identity derives from the host's package.json;
  the umbrella passes the fixed mount.
- `packages/vendo/src/cli/doctor.ts` already live-probes `/status`, both OAuth
  metadata documents, and the server card when `blocks.mcp` is true.
- `packages/vendo/src/cli/init.ts` asks the "open the MCP door?" question and
  prints HostOAuthAdapter guidance; it scaffolds nothing MCP-specific.
- Nothing generates a registry `server.json` or the `mcp-registry-auth`
  challenge file anywhere.

## Locked decisions

1. **Scope split with workstream A:** C owns the *discovery* surface — the
   registry `server.json` artifact, the `/.well-known/mcp-registry-auth`
   challenge file, and doctor's discovery validation. The init-generated
   Next.js sibling `.well-known` routes for the OAuth families stay in A's
   hardening backlog (flagged to the parent; C's init work must not collide).
2. **CLI shape:** one new `vendo mcp` subcommand group with two verbs —
   `server-json` (generate/refresh the registry artifact from host config) and
   `verify-domain` (generate the keypair, print the DNS TXT record, optionally
   write the HTTP challenge file into the host's public static dir). Doctor
   grows discovery checks; init points at the new commands in its MCP guidance
   line rather than growing new prompts.
3. **server.json derivation:** identity (name/description/version) from the
   host's package.json — the same source the door's initialize handshake uses —
   plus explicit inputs for domain and public URL (flags or prompts; no
   guessing). Name = reverse-DNS of the customer domain + a product slug.
   Schema pinned to 2025-12-11; the artifact carries `$schema` so drift is
   visible.
4. **Doctor validation:** when the door is open and a `server.json` exists,
   doctor validates it structurally against the pinned schema, checks
   name/domain/URL consistency (namespace matches domain, remote URL on that
   domain, URL agrees with the live door it just probed), and reports the
   registry-auth challenge file when the HTTP method is in use.
5. **Key custody:** the DNS-verification private key is never generated into
   the repo or committed; tooling writes it to a caller-chosen path outside the
   worktree default and prints custody guidance. For ENG-282, Yousef holds the
   vendo.run key.
6. **Registry preview risk accepted:** publish to the real registry; if a data
   reset wipes the listing, republish.

## Tasks

### Task 1 — ENG-280: `vendo mcp` tooling + doctor discovery validation

Branch `yousef/eng-280-serverjson-well-known-generation-in-vendo-cli-doctor`,
one PR against main. TDD throughout (repo standard); follow the existing CLI
module pattern (`packages/vendo/src/cli/*` — one module per command, sibling
`.test.ts`, wired through the CLI entry).

1. `vendo mcp server-json`: generate `server.json` at the host root from
   package.json + domain/URL inputs; refuse to clobber a hand-edited file
   without an explicit overwrite flag; validate output against the pinned
   schema before writing. Unit tests cover derivation, validation failure, and
   overwrite behavior.
2. `vendo mcp verify-domain`: emit keypair + TXT record text (DNS method) and
   the challenge-file content (HTTP method); write the challenge file into the
   host's static dir only when asked. Tests cover both methods and key-custody
   behavior (no key material inside the project unless explicitly pathed).
3. Doctor: add the discovery checks from locked decision 4 behind the existing
   `mcpEnabled` gate; extend `doctor.test.ts` fixtures. Keep the existing three
   probes untouched.
4. Init: update the MCP guidance line to name the two new commands.
5. Docs-adjacent code comments cite contract `10-mcp` §5 the way the existing
   door/doctor code does. Full gate green, PR opened, Linear ENG-280 updated.

### Task 2 — ENG-281: customer publish-flow docs

Branch `yousef/eng-281-customer-publish-flow-docs`, one PR. Starts once Task 1's
PR is open (docs must reference the real CLI UX, not a guess).

1. One customer-facing doc in `docs/` (mirrored into `docs-site/` following the
   existing docs-site structure): the end-to-end listing path — choose the
   reverse-DNS namespace, prove domain ownership (both DNS TXT and HTTP
   challenge variants, using `vendo mcp verify-domain`), generate `server.json`
   (`vendo mcp server-json`), validate with `vendo doctor`, publish with
   `mcp-publisher`, and what users then see in Claude.ai / ChatGPT / Cursor.
2. Include the namespace/URL binding constraint prominently (remote URL must
   live on the namespace domain).
3. Directory-submission landscape (Claude Connectors Directory, ChatGPT apps)
   as clearly-labeled follow-up guidance — submissions are out of scope.
4. Every command in the doc actually run against a fixture host before the PR
   ships (docs bar from the docs-sync wave: no hallucinated flags).

### Task 3 — ENG-282: publish deployed Maple + discovery→install GIF

Blocked on: workstream A's Maple deploy fronted by a vendo.run subdomain, and
Yousef adding the DNS TXT record (or hosting the HTTP challenge) for vendo.run.
Prep now, execute when unblocked.

1. Prep (unblocked): draft Maple's `server.json` with the Task-1 tooling
   against the fixture host; install `mcp-publisher`; write the exact TXT
   record request to hand Yousef through the parent.
2. Execute (once A delivers the URL + DNS lands): `mcp-publisher login dns`
   (or http) for vendo.run, publish, confirm the listing resolves via the
   registry API and at least one aggregator/client surface.
3. Capture the discovery→install GIF on a real client and attach it to the PR
   /Linear issue. Republish without fuss if the preview registry resets.

## Dependencies and coordination

- Task 1 → Task 2 (docs reference the shipped UX). Task 3 prep is parallel;
  Task 3 execution waits on A (deploy) + Yousef (DNS) — both requested through
  the parent session.
- Watch item from the parent: A's init-generated `.well-known` sibling routes
  must not collide with C's init guidance edit (same file, small diff).

## Verification

- Per task: full repo gate green; new CLI paths covered by unit tests; doctor
  checks exercised against a live fixture host (the mcp e2e fixtures) — not
  mocks only.
- Workstream finish line: Maple listed on the official registry under
  vendo.run, resolvable through the registry API, discovery→install GIF
  captured on a real client.
