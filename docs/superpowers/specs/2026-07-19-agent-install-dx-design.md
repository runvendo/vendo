# Agent Install DX — Design

**Date:** 2026-07-19
**Status:** Approved by Yousef (brainstorm session)

## Goal

Make installing Vendo through a coding agent (Claude Code, Codex) as easy as
possible. A developer either types "add Vendo to my app" or pastes a one-line
prompt from our docs; their agent completes the installation and setup without
detours. Finish line: install + setup complete, gated by `vendo doctor`.

## Decisions locked

- **Finish line:** installation and setup complete. Not browser-verified demo,
  not prod path.
- **Entry points:** natural prompt to the agent, plus a copy-paste prompt block
  in the docs. No CLI-spawns-agent flow, no required plugin install.
- **Labor split:** CLI-first. The agent runs `vendo init` for everything
  deterministic and hand-writes only host-specific wiring (tools, auth glue).
- **Human decisions:** CLI/playbook detect what they can; the agent relays only
  genuinely human calls (account creation, Cloud vs BYO key) to its user.
- **Playbook homes:** inside the `vendoai` npm package (version-matched) and
  mirrored at stable docs URLs. Repo files canonical; CI sync check.
- **Doc shape:** hub + task-scoped leaves, not a monolith.
- **Verification:** `vendo doctor --json` is the single machine-readable gate.
- **V1 scope:** Next.js + Express (what init detects and the corpus exercises),
  with a generic-Node fallback section.
- **Approach:** static knowledge + CLI-emitted repo-specific tail (Approach C).
- **All three layers ship in v1**, including the auth.md protocol on Vendo
  Cloud.

## Architecture: three layers, one source of truth

### Layer 1 — In-package playbook

Ships inside the `vendoai` package; after `npm i vendoai` it sits in
`node_modules/vendoai/`, version-matched to the installed code, readable
offline.

1. **`AGENTS.md`** (hub, ~1 page) — what Vendo is in three sentences; the
   install flow as a numbered sequence (detect stack → init with flags →
   hand-wire the gaps init names → doctor until green); rules of engagement:
   ask your human before creating accounts or keys, never invent props or
   tools outside the catalog, doctor green is the only definition of done.
   Links to the leaves.
2. **`host-auth.md`** — wiring the host's auth into Vendo: the 5 presets, how
   to detect which one the host uses, exact wiring per preset, what to ask the
   human when ambiguous. (Named to avoid colliding with the auth.md protocol.)
3. **`tools.md`** — exposing the host API as Vendo tools: two-file surface,
   what makes a good tool, the catalog contract and anti-prop-invention rules.
4. **`verify.md`** — every doctor check and error code with symptom → cause →
   exact fix, 1:1 with `doctor --json` output.

### Layer 2 — Agent-accessible docs site

- Mirror the four playbook files as raw-fetchable markdown pages.
- `agents.md` at the vendo.run root: points agents at the install flow and the
  in-package playbook ("install, then read node_modules/vendoai/AGENTS.md").
- Mintlify freebies, confirmed enabled at implementation: `llms.txt`,
  `llms-full.txt`, `skill.md`, per-page markdown via `.md` suffix / content
  negotiation, docs MCP server, contextual menu (copy page / open in Claude).
- The docs MCP server is mentioned in `agents.md` so agents can query docs
  mid-install instead of reading pages.

### Layer 3 — auth.md protocol on Vendo Cloud

Publish the WorkOS auth.md agent-registration protocol on vendo.run over the
existing mint/gateway path:

- `vendo.run/auth.md` + `/.well-known/oauth-protected-resource` metadata.
- **User-claimed flow first** (device-code style: agent shows a code, human
  confirms once in browser) — works with every agent today.
- **Identity-assertion flow** (ID-JAG signed by the agent provider) when
  providers support it.
- Effect: the VENDO_API_KEY step becomes "agent registers the dev, mints the
  key, writes `.env`" with one human approval — no browser signup detour.

## CLI changes

1. **Full non-interactive init.** Every wizard question becomes a flag
   (`--auth`, `--framework`, `--cloud-key` / `--byo`). A missing flag in
   non-interactive mode errors with the exact flag name — never falls back to
   an interactive prompt an agent would hang on.
2. **Agent tail.** When init detects agent driving (`--agent` or non-TTY), its
   final output becomes a repo-specific block: which auth preset was wired and
   what's stubbed, the exact files to hand-edit with one-line descriptions,
   and the doctor command to gate on. Human runs keep the clack-style output.
3. **`vendo doctor --json`.** Each check emits `{id, status, error_code,
   fix_ref}`; `fix_ref` anchors into `verify.md`. Nonzero exit until all
   green. The agent's remediation loop is: doctor → read fix_ref → fix →
   repeat.
4. **Key mint integration.** When the human picks Cloud and no key exists,
   the auth.md registration flow mints the key and writes `.env`.

## Entry points

- **Natural prompt:** web discovery lands on `agents.md` / llms.txt → install
  page → "install the package, then follow the in-package playbook." Site copy
  only needs to stay correct about how to start.
- **Copy-paste prompt block** on the docs install page and README:

  > Install Vendo in this repo. Run `npm i vendoai`, then read
  > `node_modules/vendoai/AGENTS.md` and follow it exactly. Use `vendo init`
  > for scaffolding — don't hand-write what it generates. Ask me before
  > creating any account or key. You're done when `vendo doctor --json`
  > reports all green.

  Every claim in this prompt must be true; it is the project's north-star
  artifact.

## Testing

**Agent-install eval** (same muscle as the corpus/generalization matrix): a
harness takes clean host repos (corpus repos + demo-bank + demo-accounting),
runs a real coding agent headless with only the copy-paste prompt, and scores:

- reached doctor-green? in how many turns?
- asked before account/key creation?
- violated playbook rules (invented tools/props, hand-wrote scaffold files)?

New failure modes found by the eval get an error code + `verify.md` section
before being called fixed.

## Error handling

- Doctor failures always carry `error_code` + `fix_ref`.
- CI checks every code doctor can emit has a matching `verify.md` anchor (no
  registry rot).
- CI sync check keeps docs-site mirrors identical to in-package canonicals.

## Out of scope (v1)

- Web Bot Auth (RFC 9421 request signing) — bot gating, not install DX.
- A shipped Claude Code skill/plugin as a required entry point.
- Prod deploy path (keys/deploy config beyond local working setup).
- Frameworks beyond Next.js + Express (generic-Node fallback prose only).

## References

- auth.md protocol: https://auth-md.com/what-is-auth-md/ (WorkOS, OAuth
  RFC 9728 discovery, ID-JAG + user-claimed flows; shipped by Cloudflare,
  Firecrawl, Resend, Monday.com)
- Mintlify AI-native features: https://www.mintlify.com/docs/ai-native
- Agent-readiness landscape: llms.txt, root agents.md, skill.md, markdown
  content negotiation, docs MCP
