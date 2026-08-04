# Connector discovery: use Composio's, keep our audit

**Date:** 2026-08-03 · **Status:** design approved by Yousef in conversation
**Supersedes:** D3 of `2026-08-03-claude-code-harness-redesign-design.md` (shipped in PR #770)

## Why

D3 shipped `search_connectors` (our keyword scoring) + `list_connections`, with a
searched toolkit expanded server-side and the client expected to re-list via
`notifications/tools/list_changed`. Two things killed it:

1. **The client never re-lists.** Claude Code's agent SDK registers no
   list-changed handler for an HTTP MCP server (measured live: exactly one
   `tools/list` per session). A tool the model just found is unreachable that turn.
2. **Keyword retrieval is weak at this scale.** Published measurements put
   keyword/BM25 over thousands of tools at 34–64% on *straightforward* requests
   vs ~94% for embeddings.

And the shape itself is one the industry abandoned: GitHub deleted
`--dynamic-toolsets` (2026-05-20, *"dynamic mode was local-only — never offered
by the remote server"*), Pipedream the same in July. Composio — whose catalog
this is — never used it: **zero occurrences of `list_changed` in 733KB of their
docs**. Their answer is a fixed set of meta-tools plus a generic dispatcher.

## The decision

**Use Composio's intelligence; keep execution on our side for the audit log.**

Not mounting their MCP server. Their session ships `COMPOSIO_MULTI_EXECUTE_TOOL`
with it and there is no documented way to serve their search without also
serving their executor — mount it and the model gets a dispatcher that executes
on their side, bypassing our guard and audit entirely. Their own docs warn about
exactly this: over MCP *"you can't intercept, reshape, log, or gate calls."*

So: **two thin tools of ours calling their APIs.**

| From Composio, unchanged | Ours |
|---|---|
| the catalog | two tool names |
| the search planner (returns reasoning, plan steps, pitfalls) | a tag→risk lookup |
| tool input schemas, returned inline with each match | the audit row |
| connection status + hosted auth links | the guard call we already have |
| per-tool risk tags (`destructiveHint`, `readOnlyHint`, …) | |

## The two tools

```
find_service_tools(need: string)
  → Composio's session search. Each match returns: slug, full argument
    schema, connected (bool), and a hosted connect link when not.
    Read-only; no audit row; no guard.

use_service_tool(slug: string, arguments: object)
  → 1. look up Composio's tag for the slug
    2. map tag → our RiskLabel; guard decides run / ask / refuse
    3. call Composio's execute
    4. write the audit row
```

Both are permanent registry tools, so the listing never changes and callability
never depends on a re-list. They work on **both** harness paths (`vendo()` and
`claudeCode()`) because they are ordinary registry tools — this fixes `vendo()`'s
connector story too, which D3 never addressed.

`list_connections` stays but is re-backed by Composio's connection API, because
"what can I connect?" is a real standalone question that search does not answer.

### Tag → risk mapping

Composio's tags are the grading nobody else can do — a host cannot judge 20,000
third-party tools, and Composio already labelled them. Map their tags to our
`RiskLabel`; where a tool carries no usable tag, it is `ungraded`, which #747
already made ask-by-default. **No name-based inference** (design §12, and #747
deleted the word lists deliberately).

## Consent and UX — nothing new gets built

Consent is **connect-time, once**, the way every OAuth product works: the user
clicks Connect, authorizes on Composio's hosted page (**we never hold the
credential**), and that connection is the standing consent for that service.
Per-call approval on a service someone just deliberately linked is friction that
teaches people to click through.

Every surface already exists and is reused verbatim:
- **connect card** — carries Composio's hosted link
- **activity row** — a connector call renders identically to a `host_*` call,
  because it travels the same guarded path
- **approval card** — only when Composio's tag says irreversible
- **audit log** — every connector action, with its toolkit named

## Deletions

- the lazy toolkit-expansion machinery in the connector adapter
- the `tools/listChanged` advertisement, the before/after listing diff, and the
  per-session replay flag in the door
- the expansion scope map, `listingScope`, and `releaseListingScope` with its
  five forwarders — all of it existed only to scope expansions
- `search_connectors`' keyword scoring

## Known cost

Claude Code's **client-side** per-tool allow/deny prompt keys on tool name, so it
becomes one entry for `use_service_tool` rather than one per connector tool. Our
own approval cards are unaffected — those come from the guard, not the client.
The hybrid Composio ships for this (a few high-risk tools listed individually,
the long tail behind the dispatcher) is available later if it matters.

## Verification

- Unit: tag→risk mapping incl. the untagged→`ungraded` path; the dispatcher
  refuses an unknown slug; the audit row is written on every dispatch and on a
  refusal.
- Integration: a connector call through the composed door produces the same
  audit shape as a `host_*` call; an unconnected service returns connect-required
  with a link; `find_service_tools` results carry schemas inline.
- Live E2E, real browser, real Composio account: find → connect card → authorize
  → use → activity row → audit row. This is the leg D3 never completed, and it
  is the done gate.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
