# The machine model

How Vendo executes apps. Three layers, one new noun (the machine), one
contract (the skin of the box). The decision record is
`docs/superpowers/specs/2026-07-19-execution-v2-design.md`; this page describes
what shipped.

## The three layers

1. **Tree app**: no server. The v2 tree document, rendered by the
   host-embedded renderer, interactive via `$state`, code islands, and guarded
   host tools. Most apps stay here. Server-shaped needs a tree app picks up
   (schedules, away runs) usually ride an **automation** on the same document
   — a trigger the automations engine fires — not a machine; see the
   escalation ladder below.
2. **Tree app + machine**: the same tree UI, plus a persistent per-app sandbox
   where execution lives: custom server code, third-party egress with secrets,
   heavy logic, working data. The machine never draws UI. **Experimental and
   off by default** — enable with
   `createVendo({ apps: { experimentalMachines: true } })`.
3. **Machine everything**: the machine also serves a real web app; the host
   embeds its URL as the app surface. The tree is gone. Experimental and off
   by default (`experimentalServedApps`, which **requires**
   `experimentalMachines`); see [Served apps](./served-apps.md).

The runtime escalates when an instruction demands it. Users never pick a
layer.

## The escalation ladder

Box graduation costs minutes (model round trips inside the box); the
automations engine covers most server-shaped needs in seconds. So when an
instruction needs server-shaped work, the judge prefers, in order:

1. **Steps automation** — the work is expressible as deterministic tool calls
   (host + connected tools + existing `fn:` refs) with jsonata reshaping,
   `forEach`, and park/resume approval gates. One model call authors the
   trigger onto the app document; the existing automations engine fires it.
   Setup completes in seconds and **no machine is provisioned**. The
   automation's last step writes its displayable result into a declared app
   records collection, and the tree gains a `vendo_apps_data_list` query over
   those rows — that is how automation results reach the board.
2. **Agentic automation** — the work needs per-run judgment (who, which, what
   tone) but every effect is tool-reachable. Same authoring path, with an
   agentic run model (an agent loop per firing). Still no machine.
3. **Box graduation** — only when actual custom code is required: real
   computation, libraries, complex persistent state, non-tool-shaped egress,
   latency-sensitive logic. This rung is **experimental**: with
   `experimentalMachines` off (the default), the create/edit refuses with a
   typed `VendoError` naming the flag — never a silent degrade to a broken
   automation.

Arming: in the composed umbrella, a ladder-authored automation is enabled
through `automations.enable`, so the standard grant-capture flow runs at
creation and the missing standing-grant approvals ride the edit result
(`EditResult.automation.pendingGrants`). An away run holds only grants
captured while present, so approving those cards is what lets scheduled runs
complete unattended.

Apps that already carry a machine keep their box workflow: a server-shaped
edit on a machine-bearing app rides the in-box agent as before, and every
runtime path over an existing machine (wake, sleep, `fn:` calls, schedules,
box edits, open) works regardless of the flag — **only new graduation and
provisioning are gated**. Existing apps are never stranded.

## The machine

A persistent per-app sandbox. It sleeps as a snapshot and wakes in about a
second when poked. Idle machines auto-sleep after 5 minutes (a request in
flight defers the timer). Sleep takes a fresh snapshot and stores its ref on
the app document; the next wake resumes it. If the provider kills a live
machine out from under us (TTL expiry, provider sweep), the next request
through the live handle evicts the dead entry and resumes the durable
snapshot ref transparently — one retry, then the error surfaces.

Which provider runs the box is the standard adapter decision, made once in
`createVendo`:

1. An explicit `sandbox: <adapter>` always wins.
2. `E2B_API_KEY` (with the optional `e2b` package installed) selects the BYO
   e2b adapter.
3. `VENDO_API_KEY` fills the slot with the Vendo Cloud hosted sandbox
   (`cloudSandbox`, exported from `@vendoai/vendo/server`; `VENDO_CLOUD_URL`
   overrides the console base URL).
4. Nothing set: machine paths fail closed with `sandbox-unavailable`.

Machine provisioning requires `VENDO_BASE_URL`: the box's callback URLs must
be this deployment's public origin. `VENDO_BOX_TEMPLATE` sets the provider
base template for BYO e2b (the image built by
`packages/apps/box/build-template.mjs`: Node plus the in-box agent harness
with the Claude Agent SDK npm-installed beside it at build time,
plus a pre-baked served-app scaffold at `/opt/vendo-box/scaffold` that layer-3
builds copy and edit instead of writing the skin plumbing from scratch);
the Cloud pool ships its own base image and takes no template.

## Graduation

**1 to 2** is invisible and additive — and, since the escalation ladder, the
LAST resort for server-shaped work: it runs only when the judge concludes the
instruction needs custom code (and `experimentalMachines` is on), or when the
app already has a machine. The runtime provisions a machine, sends the build to the in-box agent, syncs
the box's `vendo.json` (schedules and egress declaration), parks an egress
approval card when the declaration needs one, and rewires the tree's data
bindings to the new `fn:` functions. The tree keeps working throughout. A
failed server build rolls back to the pre-edit snapshot; a failed tree rebind
(3 attempts) keeps the working tree and reports the miss in `issues`.

The rebind checks binding paths against the fn's real result shape: each fn a
query binds is sampled once (the same call the query itself makes; fn
responses unwrap their `{result}` envelope), the sampled shape feeds the edit
compiler's binding type-check, and a mismatch (for example a host tool's
`/data/` envelope path carried onto an fn: query) routes to per-binding
repair instead of persisting a tree that renders blanks. A failed sample
leaves that fn's shape unknown and defensive.

**2 to 3** is an honest UI rewrite in the same box, gated behind the
experimental served-apps flag. The tree keeps serving until the new surface is
verified live, then the surface flips. See [Served apps](./served-apps.md).

## The skin of the box

Inside the box is free country: any language, any framework, any process.
Vendo owns only the boundary.

### In: environment variables

`buildEnv` (packages/apps/src/box-env.ts) assembles these when the machine is
provisioned. A wake resumes the snapshot's environment; before every in-box
edit the host re-injects the current set through the agent control port and
restarts the app. A secret grant decided while a machine exists also marks the
machine env-stale on the document (and puts a running box to sleep), so the
next wake rebuilds the env through the same control-port door — a grant flip
lands at the next wake, not just the next edit:

| Variable | Contents |
| --- | --- |
| `PORT` | where the app must listen (default 8080) |
| `VENDO_STORE_URL` | base URL of the durable-rows callback surface (the wire's `/box` mount) |
| `VENDO_HOST_URL` | base URL of the host-tools callback surface (same mount) |
| `VENDO_APP_TOKEN` | the per-app bearer minted at provision; authenticates every `/box` call |
| `VENDO_INFERENCE_URL` / `VENDO_INFERENCE_KEY` | the in-box agent's model door (absent when no inference is configured) |
| `VENDO_INFERENCE_MODEL` | optional model choice the harness reads (added by the composition beside `buildEnv`'s output) |
| declared secret names | real values, for declared and granted secrets only |

The `buildEnv` boundary names (all of the above except `VENDO_INFERENCE_MODEL`)
are reserved: a secret named like one of them is a validation error. Secrets are injected by their own names; the box does its
own allowlisted egress with them (no handles, no egress proxy).

The inference door resolves host-side: explicit `VENDO_INFERENCE_URL` and
`VENDO_INFERENCE_KEY` win; otherwise `ANTHROPIC_API_KEY` rides
`https://api.anthropic.com`; otherwise `VENDO_API_KEY` rides the Vendo Cloud
model gateway (`<console>/api/v1`) — the same key that provisions a Cloud
machine funds its model; otherwise the box gets no inference vars.

### Out: HTTP on `$PORT`

- `POST /fn/<name>`: tree-callable functions and schedule targets. Names match
  `[A-Za-z_][A-Za-z0-9_-]{0,63}`. The request body is `{args}` JSON. A 2xx
  response must be a JSON object envelope carrying `result`; a missing
  `result` or a present `ui` member is a validation error, because the
  machine never draws UI. Errors relay as `{error: {code, message}}`.
- `GET /vendo.json`: the manifest (below). 404 means no declarations.
- Anything else served is the layer-3 web app. Layer 2 vs 3 is not a mode,
  just which paths the app serves.

A v2 tree names a box function as `fn:<name>` in a query or action `tool`
ref. A failed fn is a contained error outcome (the query slot stays unbound,
the action renders its error state), never a thrown white box. The
authenticated end-user proxy (`POST /apps/:appId/fn/:name`) forwards only the
payload and content-type, no cookies or authorization headers, and times out
the wire request at 30 s (code `timeout`, HTTP 504). Requests right after a
wake retry the provider's transient 502/503 while the app rebinds `$PORT`.

### The manifest: `vendo.json`

Served at the box root. Exactly two declarations, both optional, strict
schema (unknown keys are validation errors):

```json
{
  "schedules": [{ "cron": "0 8 * * *", "fn": "chaseInvoices" }],
  "egress": ["api.stripe.com"]
}
```

- `schedules`: "at this cron, POST /fn/<name>". Five-field cron, evaluated in
  UTC by the host. Declarative; no runtime library inside the box.
- `egress`: the outbound-domain allowlist the sandbox network layer enforces
  (after owner approval, below).

The host reads the manifest over the box door after every server edit,
whenever the machine is awake at tick time, and once on the first tick after
graduation. A manifest edited while the machine sleeps is picked up the next
time it is awake.

### Back in: the `/box` callback surface

Plain HTTP on the host's Vendo server (mounted at `<VENDO_BASE_URL>/api/vendo/box`),
curl-able from any language inside the box. The bearer is the identity: every
request carries `Authorization: Bearer $VENDO_APP_TOKEN`; an invalid token
answers 401. The box acts as the app's owner, away, in the app venue. The box
never holds host credentials; this surface is its single authority path.

| Route | Methods | Purpose |
| --- | --- | --- |
| `/box/rows/<collection>` | GET | list rows (`refs.<key>=<value>`, `limit`, `cursor`) |
| `/box/rows/<collection>/<id>` | GET · PUT · DELETE | one durable row; PUT body is `{data, refs?}`, 256 KB cap |
| `/box/tools/<name>` | POST | host tool call through the same guard-bound registry chat uses; body is `{args}` |

Rows land in the app-scoped store namespace (`app:<appId>:box:<collection>`).
Tool calls see policy, grants, approvals, and audit exactly like every other
venue; an ask-policy tool comes back `{status: "pending-approval"}`, relayed,
never bypassed. A redaction guard scrubs known secret values from row payloads
before persist and from every response body (`[redacted:<name>]`).

## Schedules and the tick

`POST /api/vendo/tick` with `Authorization: Bearer <VENDO_TICK_SECRET>` drives
both schedulers: automation schedules and machine-app `vendo.json` schedules.
Registration is just pointing a caller at that endpoint. Point any external
cron at it (Vercel cron, a GitHub Actions schedule, crontab); Vendo Cloud's
hosted broker is another caller of the same surface, not a separate protocol.

Due-ness is computed from store-cached state, so a routine tick never wakes a
sleeping machine just to check schedules (the first tick after graduation
wakes once to learn them). Each due target fires as `POST /fn/<name>` as the app
owner's away execution, exactly once per cron window (the fire is claimed in
the store before the POST, so double-hitting cron services cannot
double-fire). A host offline for months collapses to one fire at the latest
occurrence; schedules never back-fill. Every fire is audited, and
`vendo doctor` reports machine-bearing apps, whether a tick caller is
configured, and last-fired state.

## The agent lives in the box

Every machine's base image includes a coding agent behind a control port
(8811), separate from the app's `$PORT`. The agent engine is the **Claude
Agent SDK** (Claude Code as a library), baked into the base template at
build time so the box inherits Anthropic's agentic-harness improvements —
install size is a template concern, never a wake concern. The SDK runs
headless with its own shell + file tools, working dir `/app`; its auth is the
same inference door mapped onto plain env (`ANTHROPIC_API_KEY` =
`VENDO_INFERENCE_KEY`, `ANTHROPIC_BASE_URL` = `VENDO_INFERENCE_URL` — BYO
Anthropic and the Cloud gateway ride identically), and `VENDO_INFERENCE_MODEL`
still picks the model (default `claude-sonnet-4-5`).

"Edit this app" sends one prompt to `POST /agent/task`; the agent writes code,
installs deps, runs the server, curls its own endpoints, fixes failures, and
reports a structured result (summary, files changed, tests run, served `fn`
names, and whether it now serves a UI) through an in-process `report_done`
tool. The host long-polls to completion. The control-port protocol is
engine-agnostic — the Wave-8 engine swap changed nothing outside the box.
Everything the box returns is data: a box result cannot approve egress, grant
a secret, or mutate a host document.

Operator knobs: `VENDO_BOX_EDIT_TIMEOUT_MS` (long-poll budget, default 8
minutes) and `VENDO_BOX_EDIT_POLL_MS`. On BYO e2b, `VENDO_E2B_TIMEOUT_MS` sets
the provider machine lifetime; when unset, a raised edit budget implies a
matching lifetime (budget plus 5 minutes) so a long build is not killed by the
provider's default TTL. The lifetime is a sliding deadline, not a hard cap:
every request and exec through the machine re-extends it (throttled to once a
minute), so the idle auto-sleep — not the provider TTL — decides when a busy
box stops. A timed-out or failed edit rolls back: the live
machine is discarded without a snapshot and the document keeps its pre-edit
ref.

## Secrets and egress

Both are approve-once grants decided by the app's owner through the guard's
ordinary high-risk approval flow.

- **Secrets**: an app declares secret names (`AppDocument.secrets`). Turning a
  declared secret on for a box parks one approval card per secret
  (`vendo_secret_expose`); only declared and granted secrets inject real
  values, at provision, at the env re-injection before each in-box edit, and
  at the first wake after a grant change: committing or revoking a grant
  marks the machine env-stale (a running box is put to sleep), and the next
  wake pushes the freshly assembled env through the agent control port, which
  restarts the app with exactly the new set. Grants live in their own
  collection, keyed by app id, and are never carried by shares, forks, or
  publishes.
- **Egress**: the app's `egress` declaration is an ask, not an authority. Each
  declared domain needs one owner approval (`vendo_egress_allow`); approving
  commits it to the document's `egressApproved` field. A machine never
  provisions or wakes with an unapproved declared domain (a loud `blocked`
  error naming the missing domains), on every path including schedule wakes.

Machine egress is deny-by-default at the provider network layer. An app that
declares nothing can reach only the implicit skin domains (the host callback
origin and the inference endpoint host), which ride every allowlist
unconditionally. A wake applies the current policy over the snapshot-time one,
so a grant decided (or revoked) while the machine slept counts at the next
resume. This is the SSRF and exfiltration answer, including for the
BYO-model-key case: the key sits in the box, but the box can only talk to
approved domains.

Caveat on the Vendo Cloud sandbox: the egress filter is HTTP(S) only. Raw TCP
is severed even to allowlisted hosts, so a direct Postgres connection from the
box never works; the HTTPS store surface (`VENDO_STORE_URL`) does.

## The data rule

Anything that needs to persist goes through the Vendo store, via the `/box`
rows surface or a host tool. The VM disk is scratch: caches, working files,
build artifacts. Snapshots are not a database; a provider sweep (Vendo Cloud
reaps idle machines at 10 minutes and everything at 24 hours) can cost
scratch state written since the last snapshot, and durable rows are what
survive by design.
