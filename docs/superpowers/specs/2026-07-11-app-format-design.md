# Vendo App Format v0 (design)

Date: 2026-07-11
Status: approved in brainstorm with Yousef; revised after triple review (Opus review, Codex review, Codex clean-room design). Feeds wave 2 (contracts) of the v0 campaign.
Ground truth: the "Open-Source Full Stack Agentic Interface" Notion page. This spec fills what the page defers to the app-format brainstorm; it changes no page decision.
Scope: the artifact format only. Runtime internals and the generation engine are out of scope. Trigger details belong to the automations wave.

## 1. Core model

One artifact for everything Vendo produces: an app is a folder with a manifest. A quick chat view is an unsaved app with only a UI. An automation is an app with a trigger. Nothing converts between kinds; fields accumulate as the app grows. The format is named `vendo/app@1`. The interchange form (sharing, the open standard, shipping to a sandbox) is the folder as a tarball, extension `.vapp`.

Apps have two origins, same format: created from new (born in conversation, no lineage, runs jailed) and remixed from the product (a pin: a fork of a host component's real source, see section 8). The user never chooses between them; both are just conversation.

```
invoice-notes/
├─ manifest.json          # identity + structure declarations
├─ ui/
│  ├─ view.json           # a Tree document (wire format: vendo-genui/v1)
│  └─ components/*.tsx    # novel agent-written components, one file each, PascalCase
├─ pins/*.tsx             # forks of host components, one per slot, named by slot id
└─ server/                # only if graduated: real code, any shape; manifest names entries
```

Not in the folder, by construction:

- The app's data. It lives in the store, per install. Sharing an app never shares data.
- The install record (see section 3): version pointer, per-user state, view cache, screenshot.
- Grants and approvals. Authority never lives in an artifact (section 7).

## 2. Storage of the artifact

The folder is a logical shape. Its canonical home is the store (host Postgres, `vendo_` tables), content-addressed so versions and forks share unchanged files. This content-addressed layer is new work, not the current flat saved-record store. The folder materializes to a real filesystem in three places: inside the sandbox at rungs 2 to 4, on `.vapp` export, and optionally as a dev checkout. Apps are addressed by id; files within an app by folder path. Tar ingestion safety and canonical hashing rules live in an implementation appendix, not this spec.

## 3. Installs

An install is the host-minted record binding an app to a user: which version is live for them, their `state`, their view cache and screenshot (the instant-open snapshot, a cache and never truth), and their storage namespace. Grants and data key off the install record, never off anything written inside the artifact. An imported or shared app always gets a fresh install: empty data, no grants, regardless of what its manifest claims.

## 4. Manifest

Keys are present only when the app has the part; absent means the app does not have it. A kept chat view carries only `format`, `id`, `name`, `ui`. Maximal example for key reference:

```json
{
  "format": "vendo/app@1",
  "id": "app_7f3k",
  "name": "Invoice Notes",
  "description": "Pin comments to invoices",
  "ui": { "kind": "tree", "source": "static" },
  "storage": { "notes": { "about": "comments pinned to invoices",
                          "refs": { "invoice_id": "host.invoice" } } },
  "server": { "entry": "server/chase.ts" },
  "trigger": { "schedule": "mon 9:00" },
  "pins": [ { "slot": "invoice-card", "base": "sha256:ab12..." } ],
  "egress": ["api.stripe.com"],
  "secrets": ["STRIPE_KEY"]
}
```

- `ui`: always an object. `kind`: `tree` or `http`. `source`: `static` or `server` (tree only).
- `storage`: named collections with a one-line description. Contents are free-form JSON, no schemas, no migrations, orphan records acceptable. The only typed part is host-entity refs (`host.` namespace, the vocabulary `vendo init` extracts), which the store materializes as indexed columns so hosts can join app records onto their entities (the mechanism is new work in the store adapter). Storage kinds are a small expandable vocabulary: `records` (default) and `files` in v0; later kinds are one new word plus a store adapter. Declaring an unsupported kind fails cleanly at install.
- `state` is a reserved built-in: one free-form record per install, zero declaration.
- `egress` and `secrets` are sandbox wiring, not a permission model: the egress allowlist the sandbox enforces, and the names of secrets injected at runtime (app code receives handles, never values).
- There is no tools or permissions field. See section 7.
- A fork mints a new `id` and records `forkOf`.

## 5. Surfaces and the ladder

The Tree is the spec name for today's payload; the wire string stays `vendo-genui/v1` (renaming it would break stored records and tool contracts for no functional gain). Fields: `root`, `nodes` (prewired | host | generated), `data`, `queries`. A tree is a file type, not a mode. Two planes by contract:

- Tree surface: instant and jailed (`connect-src 'none'`), millisecond compile, catalog-validated before shipping.
- Sandbox: no ceiling, boot-tolerant, snapshot-resumed.

The ladder (the agent escalates; the user never picks a tier):

1. Static tree. No sandbox.
2. Tree + server functions. UI unchanged; buttons and queries call sandbox functions.
3. Server-computed tree. The sandbox returns trees; rendering stays on the instant path.
4. Served UI. The sandbox serves a real web app; iframe `connect-src` is the sandbox origin plus manifest egress. Last resort, only when the interface outgrows trees. Never a prerequisite.

Invisible graduation is a product requirement on runtimes (non-normative for the format): the tree renderer ships in served-app scaffolds so the first served version renders the identical tree; apps open on their last state (live tree at rungs 1 to 3, dimmed screenshot at rung 4); the old rung serves while the next builds.

## 6. Versions and editing

Git-shaped, not git. A version is an immutable content-addressed snapshot of the folder. `head` points at the live version (in the registry, not the folder); rollback moves the pointer; remix is a fork. Each version records the intent that produced it, so history reads as a changelog. Rollback rewinds code, never data. Real git appears only inside rung-4 sandboxes if the agent chooses.

Editing is one loop (patch, validate, version with intent, rehearse before reality) with two dialects:

- Tree edits: structured operations validated against the host catalog before applying. Instant. A completed tree cannot ship broken; partial trees exist only as stream states, never as persisted versions.
- Code edits: text hunks, syntax-checked at compile (transform only, not typecheck), contained by error boundaries at runtime.

Hand-editing files is a first-class escape hatch.

## 7. The one security rule

An app never has authority. Only the user running it does, and guard (the umbrella term for the existing consent, policy, and grant-store machinery) asks that user in context at the moment of the call: input previews, exact or constrained scopes, durations, and critical tools always ask. Approvals never transfer between users.

Everything follows from the rule:

- A shared app with hidden or dormant calls can do nothing: when the call fires, the running user is asked, sees the inputs, and decides. There is nothing to predict at review time because nothing runs without in-context consent.
- Grants key off the install record (section 3), so no artifact can arrive with, claim, or inherit authority. Exports carry zero authority by construction.
- Away runs (automations) hold only the grants captured while the user was present (page rule). An ungranted call fails soft and queues for approval.
- Org publishing (cloud) controls distribution, never authority.

Keying grants per install is new work: today's grants are keyed per user and tool only.

## 8. Pins

A pin is an edit of the host's actual component source, running in the product after host approval.

- The host marks a component remixable (opt-in, per file). `vendo sync` captures its real source. Backend code is never captured.
- A pin is a fork with lineage: the edited source plus `{ slot, base: sourceHash }`. Same editing loop as everything else, rehearsed in the furnished jail (real sub-components and styles, host-state hooks stubbed with recorded data).
- Approval reviews the net diff against the host baseline and pins the content hash in the host registry. The host page never executes unapproved code.
- Approved pins mount in the host's real React tree with full host-page authority; the diff review is the control, stated plainly.
- Host component updates mark the pin drifted; the agent rebases recorded intents onto the new baseline, through approval again. An erroring pin falls back to the original component.
- Dependency capture depth and closure hashing are implementation notes, not format.

## 9. Sharing and export

- Sharing hands over a frozen copy: fresh install, empty data, no grants.
- A `.vapp` export contains only the folder. Data, caches, and grants live outside it by construction and cannot leak.
- Host-derived files (pins) export only with host permission; export fails rather than silently stripping them (a stripped pin changes behavior).
- Jail and sandbox rules are unchanged by sharing: no network in the jail, manifest egress in the sandbox, secrets never readable.

## 10. Encoding commitments

Named now, designed later: a token-compact wire profile of the tree (same structure, mechanically convertible with the readable form); valid-while-partial streaming semantics; catalog-aware autofix (hallucinated names corrected without a model round-trip).

## 11. Deferred

- Compact encoding design and benchmarks.
- Trigger declaration details (automations wave).
- Server block execution contract (runtime id, build and start commands, function-export mapping) and tree references to server functions: wave 2 contracts work.
- Pin capture-depth rules.
- Jail dependency set: fixed blessed kit vs per-host vendored extensions.
- Tar ingestion and canonical hashing appendix.
- Marketplace and cross-org distribution.
