---
"@vendoai/vendo": patch
---

Docs: the pages say what the code does, and the fix is where it bites.

Four published statements were false. `environment-variables` said `NODE_ENV`
fails closed on both the telemetry collector and the local store's
plaintext-secret allowance — it fails closed on telemetry and **open** on
secrets, so a deploy that never sets `NODE_ENV` stored secrets in plaintext
behind one `console.warn` while the docs promised the opposite. That row is now
two statements, with the fail-open and both ways to shut it stated plainly.
`how-vendo-works` and `how-it-works` said prompts go to Vendo's model gateway
unconditionally; on a composition that selects its own model object the call
goes straight to that provider and Vendo's servers never see it. The
`existing-agent` quickstart implied `vendo doctor` catches a mismatched
`@ai-sdk/anthropic` major — E-DEP-001 inspects the `ai` major and nothing else,
so that pin is the reader's to keep by hand, and the page now says so.

`server-api`'s `Vendo` interface was missing four real members: `tokenFor`,
`putUserFile`, `agent`, and `tenantConnectors` — `handler-options` already
pointed at `putUserFile` with nowhere to land.

`how-vendo-works` promised a walkthrough under "One request, end to end" and
delivered one sentence and the next heading; it now walks a real question
through all five boxes. The MCP quickstart's first real call carries the 60s
opt-in it needs, matching `your-own-agent`. The index quickstart's third step
led with a byte-identical repeat of the second step's terminal transcript.

Three troubleshooting pages were unreachable from the error-code index —
E-MODEL-001, E-TOOLS-005, and E-AUTH-009, which is live and had no row at all.
New page for a stock MCP client dying at 60 seconds on a long `vendo_make`,
which is not a doctor code and so had nowhere to be listed.

The CLI and hooks references had six more statements that did not match the
code. `cli` glossed `--base-url` as "where this deploys" when it is a dev URL
that must never hold a deployed one; gave the pre-0.4.2 `~/.vendo/pending-claim.json`
path, which is now read once for migration and deleted; omitted `vendo sync`'s
exit `1`; and claimed every command rejects an unknown option, which only
`init`, `login`, `doctor`, `sync`, and `knowledge` do — `eject`, `mcp`, `cloud`,
and `config` ignore them, and `vendo cloud device-login` diverges from `vendo
login` for that reason. `hooks` said every documented hook is re-exported from
`@vendoai/vendo/react`; `useApprovalModal` ships only on `@vendoai/ui/chrome`,
and `useVendoClientOrNone` is in no published entrypoint at all, so its row is
gone rather than sending readers at an import that cannot resolve. Both `cli`
and `vendo-init` now carry the broker's https refusal.

Polish where the reader hits the instruction second: `api-tools` gains the
`compounds` snippet it only described, with the two loader rules that quarantine
an entry; `automations` leads with `useAutomations()` before the hand-built
`RunContext`; `backend/quickstart` shows the two-line model swap instead of
describing it; `connectors`, `knowledge`, and `erasing-a-user` lead with the
instruction.
