# Vendo App Format v0 (design)

Date: 2026-07-11
Status: approved with Yousef after triple review (Opus review, Codex review, Codex clean-room design) and successive simplification. Feeds wave 2 (contracts) of the v0 campaign.
Ground truth: the "Open-Source Full Stack Agentic Interface" Notion page. This spec changes no page decision.
Scope: the artifact format only. How a runtime stores apps (tables, caches, history) is the runtime's business, not this spec's. Trigger details belong to the automations wave.

## 1. The format

An app is one document. Fields are absent until the app grows them. A quick chat view is this document with only `name`, `ui`, and `tree`; an automation is the same document with a `trigger`.

```json
{
  "format": "vendo/app@1",
  "id": "app_7f3k",
  "name": "Invoice Chaser",
  "description": "Chases overdue invoices every Monday",
  "ui": "tree",
  "tree": { "root": "...", "nodes": ["..."], "data": {}, "queries": ["..."] },
  "components": { "SpendChart": "export default function SpendChart(props) { ... }" },
  "storage": { "notes": { "about": "comments pinned to invoices",
                          "refs": { "invoice_id": "host.invoice" } } },
  "server": "e2b:snap_x91",
  "trigger": { "schedule": "mon 9:00" },
  "egress": ["api.stripe.com"],
  "secrets": ["STRIPE_KEY"],
  "pins": [ { "slot": "invoice-card", "base": "sha256:ab12..." } ],
  "forkedFrom": "app_2c9d"
}
```

Export: the document plus the app's directory (pulled from the snapshot, when one exists) zipped as `<name>.vendoapp`. Import: load the document, spin a fresh machine from the directory if present.

## 2. The fields

- `ui`: `tree` (rendered on the instant jailed path) or `http` (served by the app's machine). With `http`, the last `tree` is kept as the fallback and loading cover.
- `tree`: the UI payload. Spec name Tree; wire format stays `vendo-genui/v1` (renaming would break stored records and tool contracts). Fields: `root`, `nodes` (prewired | host | generated), `data`, `queries`.
- `components`: novel agent-written JSX, compiled in milliseconds, run in the jail.
- `storage`: named record collections. One-line description each, free-form JSON contents, no schemas, no migrations, orphans acceptable. Only host-entity refs are typed (`host.` namespace) so hosts can join app records onto their entities. `state` is a reserved built-in: one free-form record per user per app, zero declaration. Kinds: `records` (default) and `files`; new kinds are one word plus a store adapter.
- `server`: a sandbox snapshot reference. The machine IS the server part: its filesystem holds the code and the app's own files (page rule: code and files persist as part of the app). No entry point is declared; by convention the app listens on `$PORT`, and UI requests, function calls, and trigger firings arrive as requests to it. The agent edits inside the machine, then it is re-snapshotted. Snapshots resume in about a second, so wake is fast.
- `trigger`: set = the app is an automation. Details owned by the automations wave.
- `egress` / `secrets`: sandbox wiring, not a permission model. The egress allowlist the machine's network enforces, and the names of secrets injected at runtime (app code gets handles, never values).
- `pins`: forks of host components (section 5).
- There is no tools or permissions field (section 4).

## 3. The ladder

The agent escalates; the user never picks a tier:

1. Tree only. Instant, jailed (`connect-src 'none'`), no machine.
2. Tree + server. UI unchanged; buttons and queries call the machine.
3. Server-computed tree. The machine returns trees; rendering stays on the instant path.
4. `ui: http`. The machine serves a real web app. Last resort, only when the interface outgrows trees. Never a prerequisite.

Invisible graduation is a requirement on runtimes: apps open on their last state (live tree, or a dimmed screenshot while the machine resumes at rung 4); the tree renderer ships in served-app scaffolds so the first served version renders the identical tree; the old rung keeps serving while the next builds.

Editing is one loop (patch, validate, apply, undo) with two dialects: tree edits are structured operations validated against the host catalog (a completed tree cannot ship broken); code edits are text hunks, syntax-checked, contained by error boundaries. Undo/history is runtime UX (a capped log), not format.

## 4. The one security rule

An app never has authority. Only the user running it does, and guard (the existing consent, policy, and grant machinery: input previews, exact or constrained scopes, critical tools always ask) asks that user in context at the moment of the call. Approvals never transfer between users.

Consequences: a shared app with hidden or dormant calls can do nothing without the running user being asked with the real inputs; artifacts and exports carry zero authority; grants and data belong to each user's install, never to the artifact; away runs hold only the grants captured while the user was present, and an ungranted call fails soft and queues for approval; org publishing (cloud) controls distribution, never authority.

## 5. Pins

A pin is an edit of the host's actual component source, running in the product after host approval.

- Host marks a component remixable (opt-in, per file); its real source is captured at sync. Backend code is never captured.
- The user edits a fork conversationally, rehearsed in the furnished jail (real sub-components and styles, stubbed data). The product keeps running the original the whole time.
- Shipping sends the net diff against the host baseline for approval; the approved copy is held by the host registry, pinned to its hash. The host page never executes unapproved code.
- Approved pins mount natively in the host page with full host-page authority; the diff review is the control.
- Host updates to the component mark the pin drifted; the agent rebases the recorded intents onto the new source, through approval again. An erroring pin falls back to the original.

## 6. Sharing and export

Sharing and publishing hand over a copy (fresh install, empty data, no grants); freezing is by copying, never by pointing into the author's history. `.vendoapp` exports contain only the document and the app directory: no data, no caches, no grants, no snapshots. Host-derived pin source exports only with host permission, and export fails rather than silently stripping the pin.

## 7. Encoding commitments

Named now, designed later: a token-compact wire profile of the tree (mechanically convertible with the readable form); valid-while-partial streaming semantics; catalog-aware autofix against the host catalog.

## 8. Deferred

- Compact encoding design and benchmarks.
- Trigger declaration details (automations wave).
- Pin capture-depth rules.
- Jail dependency set: fixed blessed kit vs per-host vendored extensions.
- Multi-view tree apps (a few named screens without graduating to http): raised, unanswered.
- Marketplace and cross-org distribution.
