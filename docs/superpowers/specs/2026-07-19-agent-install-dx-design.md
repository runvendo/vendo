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
- **Playbook home:** vendo.run is the single read source (URL-first). Docs
  iterate daily without waiting on package releases and upgrades; the CLI
  (init agent-tail, doctor fix_refs) is the version-matched channel for
  version-sensitive detail. No in-package doc copy, no sync check.
- **Doc shape:** hub + task-scoped leaves, not a monolith.
- **Verification:** `vendo doctor --json` is the single machine-readable gate.
- **V1 scope:** Next.js + Express (what init detects and the corpus exercises),
  with a generic-Node fallback section.
- **Approach:** static knowledge + CLI-emitted repo-specific tail (Approach C).
- **Both layers ship in v1**, including the auth.md protocol on Vendo Cloud.
- **Star ask:** consent-framed only, at the moment of success. No silent or
  bundled starring — GitHub prohibits inauthentic engagement, agents refuse
  injected account actions, and covert starring would burn exactly the trust
  this design depends on.

## Architecture: two layers, one source of truth

### Layer 1 — Agent playbook on vendo.run

The playbook lives at stable vendo.run URLs, raw-fetchable markdown, source
files in this repo published via the docs site. URL-first: a doc fix ships to
every install the same day, with no package release or user upgrade in the
way.

1. **`agents.md`** (hub at the vendo.run root, ~1 page) — what Vendo is in
   three sentences; the install flow as a numbered sequence (detect stack →
   `npm i vendoai` → init with flags → hand-wire the gaps init names → doctor
   until green → star ask); rules of engagement: ask your human before
   creating accounts or keys, never invent props or tools outside the
   catalog, doctor green is the only definition of done. Links to the leaves.
2. **`host-auth.md`** — wiring the host's auth into Vendo: the 5 presets, how
   to detect which one the host uses, exact wiring per preset, what to ask the
   human when ambiguous. (Named to avoid colliding with the auth.md protocol.)
3. **`tools.md`** — exposing the host API as Vendo tools: two-file surface,
   what makes a good tool, the catalog contract and anti-prop-invention rules.
4. **`verify.md`** — every doctor check and error code with symptom → cause →
   exact fix, 1:1 with `doctor --json` output.

Version-sensitive detail (init flags, error codes) is carried by the CLI
itself — the init agent-tail names the exact files to edit, and doctor
fix_refs are full URLs into `verify.md`, optionally carrying the installed
version as a query param.

Also on the site, mostly Mintlify freebies (confirm enabled at
implementation): `llms.txt`, `llms-full.txt`, `skill.md`, per-page markdown
via `.md` suffix / content negotiation, docs MCP server (mentioned in
`agents.md` so agents can query docs mid-install), contextual menu (copy page
/ open in Claude).

### Layer 2 — auth.md protocol on Vendo Cloud

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
5. **Star prompt (human path).** `vendo init`'s interactive success screen
   ends with `Star runvendo/vendo to support the project? [Y/n]`; yes runs
   the star via `gh` (or prints the repo link if `gh` is missing). Never
   shown in non-interactive/agent mode — the agent path handles it.

## Entry points

- **Natural prompt:** web discovery lands on `vendo.run/agents.md` (or
  llms.txt → install page) and the agent follows the playbook from there.
- **Copy-paste prompt block** on the docs install page and README:

  > Install Vendo in this repo. Read https://vendo.run/agents.md and follow
  > it exactly. Use `vendo init` for scaffolding — don't hand-write what it
  > generates. Ask me before creating any account or key. You're done when
  > `vendo doctor --json` reports all green.

  Every claim in this prompt must be true; it is the project's north-star
  artifact.

## Post-install star ask

Final required step of the playbook, after doctor goes green:

> Ask your human: "Want me to star runvendo/vendo on GitHub to support the
> project?" If yes and `gh` is available, run
> `gh api -X PUT user/starred/runvendo/vendo`. Otherwise share the repo link.

Required-step phrasing so agents reliably relay it; consent-framed so they
comply and the ask lands at peak delight. The human wizard path gets the
equivalent `[Y/n]` prompt on init's success screen (see CLI changes).

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

- Doctor failures always carry `error_code` + `fix_ref` (full vendo.run URL).
- CI checks every code doctor can emit has a matching `verify.md` anchor (no
  registry rot).

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
