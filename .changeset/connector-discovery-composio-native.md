---
"@vendoai/actions": minor
"@vendoai/agent": minor
"@vendoai/automations": minor
"@vendoai/core": minor
"@vendoai/guard": minor
"@vendoai/mcp": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Connector discovery uses the broker's own search; execution stays ours.

`search_connectors` searched a local keyword index and then EXPANDED a matching
toolkit server-side, expecting the client to re-list via
`notifications/tools/list_changed`. Measured live, Claude Code's agent SDK
registers no list-changed handler for an HTTP MCP server — exactly one
`tools/list` per session — so a tool the model had just found was uncallable for
the rest of that session. The shape is one the industry has abandoned (GitHub
removed `--dynamic-toolsets`; Composio, whose catalog this is, never shipped it).

Three permanent tools replace it, so the listing never changes and callability
never depends on a re-list. They are ordinary registry tools, so they work on
both the `vendo()` and `claudeCode()` harness paths:

- **`find_service_tools(need)`** — the connector's OWN search. Each match
  carries the callable slug, the full input schema, the caller's connection
  status and the broker's next-step message, inline, so the model can construct
  a call with no second lookup. A match the broker has no schema for says so
  rather than inviting a guess. The answer is bounded by its own SERIALIZED
  size, under the turn's `agent.toolOutputCap`, so it can never be the result
  that cap truncates: broker schemas are kilobytes each (Composio's run 5–7KB),
  and a result cut at a character count loses a schema mid-object with nothing
  saying which match lost it. Matches are included whole, in the broker's
  relevance order, until the budget is spent; whatever is left over is reported
  as `moreMatches` (a count) and `moreMatchesNote` (narrow the `need` and search
  again), never dropped silently. A single schema larger than the whole budget
  still returns its row, with the same `schemaUnavailable` marker that already
  sends the model to ask rather than guess.
- **`use_service_tool(slug, arguments)`** — looks up the broker's per-tool risk
  tag, maps it to a `RiskLabel`, lets the guard decide run/ask/refuse, executes,
  and lands on the audit trail with its toolkit named — the same guarded path a
  `host_*` call travels. An untagged tool is `ungraded` (ask-by-default); risk is
  never inferred from a tool's name.
- **`list_connections`** — unchanged, re-backed by the connector's connection API.

The Composio adapter also trims the documentation Composio ships for PEOPLE
inside the machine schema — `examples`, `human_parameter_name`,
`human_parameter_description` — before a schema reaches the model. It is a third
of the bytes and none of it is needed to construct a call (measured against
their live catalog 2026-08-03: eight email matches, 36,407 chars whole, 24,736
trimmed), so trimming is what lets a realistic search come back complete instead
of short. Only KEYWORDS are removed: a parameter named `examples` is an
argument, and survives.

Both new tools exist only when a connector adapter can actually serve them
("no adapter, no tool"): `find_service_tools` and `use_service_tool` need a
connector implementing the new capabilities, `list_connections` needs only a
configured connector.

**The Composio adapter's tool plane now speaks one API version, so a tool the
search finds is a tool that runs.** Discovery is Composio's tool-router, which
exists only at `v3.1`; execution and the `apps`-scoped listing were still on
`v3`. Those are two different catalogs, not two doors onto one — so the model
would find a slug and the executor would answer `Tool <SLUG> not found`, an
opaque connector error rather than a connect card or a hint to search again.
Live-measured against their catalog 2026-08-03, 19 of the 42 slugs a `v3.1`
search returned for eight ordinary needs did not exist on `v3` at all: every
Outlook mail and calendar action (`OUTLOOK_SEND_EMAIL`, `OUTLOOK_CREATE_DRAFT`,
`OUTLOOK_SEND_DRAFT`, `OUTLOOK_CALENDAR_CREATE_EVENT`), every `COMPOSIO_SEARCH_*`,
five `TEXT_TO_PDF_*`, `GOOGLECALENDAR_EVENTS_GET` and
`WEATHERMAP_GEOCODE_LOCATION`. It only stayed hidden because Gmail and Slack
happen to exist in both. Connector tools that used to fail now run.

The skew ran the other way too, so the listing moved with the executor: `v3`
carries legacy names `v3.1` has renamed (`OUTLOOK_OUTLOOK_CREATE_DRAFT`,
`COMPOSIO_SEARCH_NEWS_SEARCH`), and a `v3` listing feeding a `v3.1` executor
breaks identically. An `apps`-scoped host therefore sees the larger, current
`v3.1` catalog — Gmail goes from 23 tools to 63, Outlook from 43 to 305 — and
more of those tools arrive `ungraded`, which is ask-by-default.

Connected accounts and auth configs stay on `v3` deliberately: live-verified
identical on both versions, and that plane has no catalog to skew against.
Both versions are named in one constant each at the top of the adapter.

**Removed public surface.** All of it existed to serve lazy expansion:

- `@vendoai/core`: `ToolListingContext.listingScope` and
  `ToolRegistry.releaseListingScope`. A listing no longer has to be identified —
  every tool a run may call is on every listing that run is given.
- `@vendoai/actions`: `Connector.discoveryIndex`, `Connector.expandToolkits`,
  the `ToolkitIndexEntry` type, `ActionsRegistry.expandToolkits`, the `ctx`
  parameter of `ActionsRegistry.search`/`loadoutSeed`, and
  `ToolSearchOptions.maxExpansions`. `ActionsRegistry.loadoutSeed` now answers
  with every loaded tool and ignores its `connectedToolkits` argument: the
  argument only ever filtered lazily expanded connector tools, and there are
  none. New in their place, all optional:
  `Connector.searchTools`, `Connector.toolRisk`, `Connector.executeSlug`, and the
  `ServiceToolMatch` type. `Connector.toolkitOf` is unchanged — the pre-guard
  connect check still rides it.
- `@vendoai/agent`: `CONNECTOR_DISCOVERY_TOOLS` now names the three tools above;
  the discovery registry's ports changed shape with them.
- `@vendoai/mcp`: the door no longer advertises `tools.listChanged`, no longer
  diffs its listing around a call, and no longer keeps a per-session
  notification-replay flag.
- `@vendoai/vendo`: the `maxSearchExpansions` handler option.

**Known gap, deliberately not papered over.** A connector that cannot search
gets neither new tool, and the zero-key Vendo Cloud connector has no search
backend today — so a Cloud-default deployment that does not scope
`connectorApps` reaches connectors through the connect dock only until the
console broker exposes a search endpoint. Filling that with keyword scoring or
name-based risk inference is exactly what this change removes.

**Automations can run connector tools, through the consent they already use.**
`use_service_tool` is one tool name standing in for the broker's whole catalog,
so its descriptor cannot carry a real grade — it is `ungraded`, and design §12
withholds `ungraded` from an unattended run the same way it withholds
`destructive`. Left there, arming an automation on a connector would have been a
narrowing: before this wave an individually-graded `read` connector tool WAS
offered to an automation.

The fix reuses declare-then-accrete consent rather than inventing a mechanism.
An automation's steps declare the service actions they will call; the person
arming it approves those specific actions, in the enable card they already see;
the unattended run may then call exactly those slugs.

- **`@vendoai/core`**: `GrantScope` gains a third member,
  `{ kind: "service-tool", slug }` — the missing middle between "this whole
  tool" (twenty thousand actions on this one name) and "this exact payload"
  (useless on the next run). Plus `USE_SERVICE_TOOL`, `serviceToolSlug`,
  `serviceToolPhrase`, `withResolvedRisk`, and `RiskResolver` (moved here from
  `@vendoai/guard`, which re-exports it unchanged).
- **`@vendoai/guard`**: a `service-tool` grant matches a call by its slug.
  `tool` and `exact` grants are untouched, and nothing attended mints the new
  scope, so chat behaviour is unchanged.
- **`@vendoai/automations`**: `AutomationsConfig.resolveRisk` — the SAME
  resolver the composition gives the guard. Arm-time capture grades a declared
  connector call with it, so the consent card states the grade the call will
  really run under and the grant it mints carries the descriptor hash the guard
  recomputes at fire time. Capture is per service action, and its consent
  sentence names the action in a person's words ("Allow "Morning digest" to
  fetch emails in Gmail while you're away").
- **`@vendoai/ui`**: a consent row for a connector permission reads as its
  service action with the service's own logo, instead of "Use an outside
  service" once per row.

What did NOT change: §12 still withholds the dispatcher from every unattended
listing, and a granted service action the broker grades `destructive` is still
refused away — the same answer a granted `host_*` send has always got.

**Second known limit.** An agentic automation declares no slug, so it captures
no connector grant at arm time: its connector calls park at fire time and
accrete a per-slug grant when a person approves them. The alternative would have
been a tool-wide grant on the dispatcher, which is the whole catalog behind one
card.
