# claudeCode() — make it just Claude Code

**Why:** today's adapter is 3,403 lines because it treats every user message as a
cold start (fresh `query()` + resume + re-materialize + machine pool + snapshot +
token rotation). It also reimplements four things the Agent SDK ships natively.

**Target shape:** one box, one live session per conversation. User types →
`streamInput()` → events stream back. Chat, exactly like the CLI.

```
HOST                                  BOX (one per conversation)
· thread + transcript                 · Claude Code session, held open
· guard + audit                       · real bash/editor, copy of user's files
· workspace (Postgres)                · no credentials
     │  message ── streamInput() ────►│
     │◄─ text ────────────────────────│
     │◄─ tool call over HTTP ─────────│  native MCP → our /api/vendo/mcp
     │◄─ wrote app.vendo (hook) ──────│  parse → render
```

## The four channels

| | How |
|---|---|
| Prompt | Keep the `claude_code` preset. Append only: who you are, talking to a customer, plain language. No wall of text. |
| Skills | `plugins: [path]` — native discovery. Keep `settingSources: []` (Anthropic's own multi-tenant advice). One `vendo` skill day one. |
| Tools | `mcpServers: { vendo: { type: "http", url, headers: { Authorization: Bearer } } }` → the MCP door we already ship. |
| Components back | Agent writes `app.vendo` to disk → `PostToolUse` hook notifies us → parse → render. Diff-sync at turn end. |

## Delete

machine pool · idle sweep · snapshot/resume-ref · token rotation handshake ·
ask/park/queue/cursor bridge · our skill projection · the appended prompt wall

## Keep

workspace materialization (our files live in a DB) · guard · audit · transcript ·
tenant isolation (`settingSources: []`, per-tenant `CLAUDE_CONFIG_DIR` + `cwd`) ·
a thin one-way channel to stream text out

## Defaults taken (no new concepts)

- Box idle timeout: leave at today's 5 min.
- Product brief: a skill, not prompt text.
- App scope: none. Tool-level permission as today; multi-app blast radius noted,
  not solved.

## The one thing that could sink it

Does our MCP door produce **identical** audit rows and approval behavior to the
in-process path? If not, tools stay in-process and only the rest changes.

## Sequencing

Wave 3 lands on `rebuild/cutover` first (their target head: 59ccb2389). Nothing
here lands until they are clear and re-gated.

## Reference

Agent SDK hosting: https://code.claude.com/docs/en/agent-sdk/hosting
MCP: https://code.claude.com/docs/en/agent-sdk/mcp
Skills: https://code.claude.com/docs/en/agent-sdk/skills
Today's code: packages/harnesses/src/claude-code/**, packages/apps/src/claude-turn.ts,
packages/apps/box/turn-routes.mjs, packages/mcp/src/door.ts
