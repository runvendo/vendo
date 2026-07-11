# Vendo App Format v0 (design)

Date: 2026-07-11
Status: approved in brainstorm with Yousef; feeds wave 2 (contracts) of the v0 campaign.
Ground truth: the "Open-Source Full Stack Agentic Interface" Notion page. This spec fills what the page defers to the app-format brainstorm; it changes no page decision.
Scope: the artifact format only. Runtime internals and the generation engine are out of scope. Trigger details belong to the automations wave.

## 1. Core model

One artifact for everything Vendo produces: an app is a folder with a manifest. A quick chat view is an unsaved app with only a UI. An automation is an app with a trigger. Nothing converts between kinds; fields accumulate as the app grows. The format is named `vendo/app@1`. The interchange form (sharing, the open standard, shipping to a sandbox) is the folder as a tarball, extension `.vapp`.

## 2. Folder layout

```
invoice-notes/
├─ manifest.json          # identity + structure declarations (the full list below)
├─ ui/
│  ├─ view.json           # a Tree document (vendo/tree@1)
│  └─ components/*.tsx    # novel agent-written components, one file each, PascalCase
├─ pins/*.tsx             # forks of host components, one per slot, named by slot id
└─ server/                # only if graduated: real code, any shape; manifest names entries
```

Not in the folder:

- The app's data. It lives in the store, per user. Sharing an app never shares data.
- The snapshot (last tree + last data, plus a screenshot at rung 4). Per-user cache kept alongside an install. Never truth: deleting it costs only the instant open.
- Grants and approvals. Trust records live in guard and the host/org registry, never in the artifact. An artifact cannot declare itself trusted, and a `.vapp` ships with zero authority.

## 3. Storage of the artifact itself

The folder is a logical shape. Its canonical home is the store (host Postgres, `vendo_` tables), content-addressed like git objects, so versions and forks share unchanged files. It materializes to a real filesystem in exactly three places: inside the sandbox at rungs 2 to 4, on `.vapp` export, and optionally as a dev checkout. Apps are addressed by `id`; files within an app by folder path.

## 4. Manifest

Keys present only when used; nothing is ever null, false, or empty. Real manifests are tiny and grow with the app: a kept chat view carries only `format`, `id`, `name`, `ui`. Maximal example for key reference:

```json
{
  "format": "vendo/app@1",
  "id": "app_7f3k",
  "name": "Invoice Notes",
  "description": "Pin comments to invoices",
  "ui": "tree",
  "storage": { "notes": { "about": "comments pinned to invoices",
                          "refs": { "invoice_id": "host.invoice" } } },
  "server": { "entry": "server/chase.ts" },
  "trigger": { "schedule": "mon 9:00" },
  "pins": [ { "slot": "invoice-card", "base": "sha256:ab12..." } ],
  "egress": ["api.stripe.com"],
  "secrets": ["STRIPE_KEY"]
}
```

- `ui`: `"tree"` shorthand for the common case; long form `{ "kind": "tree" | "http", "source": "static" | "server" }` for the upper rungs.
- `storage`: named collections with a one-line human description. Contents are free-form JSON, no schemas, no migrations, orphan records are acceptable (WordPress postmeta spirit, per the page). The only typed part is host-entity refs (`host.` namespace, same vocabulary `vendo init` extracts), which become indexed columns so hosts can join app records onto their entities. This one declared line is what makes the custom-fields story work. Storage kinds are a small expandable vocabulary: `records` (Postgres) and `files` (file storage) in v0; later kinds (vectors, kv, queues) are one new word plus a store adapter, no format surgery. An app declaring an unsupported kind fails cleanly at install.
- `state` is a reserved built-in: one singleton free-form record per user per app, zero declaration. The ladder's "state" rung exists experientially but costs no format concept.
- There is no permissions or tools field. See section 8.
- Fork lineage: a fork mints a new `id` and records `forkOf`.

## 5. Surfaces and the ladder

The Tree (`vendo/tree@1`) is the formalization of today's `vendo-genui/v1` payload: `root`, `nodes` (prewired | host | generated), `data`, `dataQueries`. A tree is a file type, not a mode; it is the fastest surface a runtime can show. Two planes by contract:

- Tree surface: instant and jailed. Renders in the egress-jailed iframe (`connect-src 'none'`), millisecond compile, no build step, host catalog validated server-side before shipping.
- Sandbox: no ceiling and boot-tolerant. Any code, any language. Snapshot-resumed so wake is seconds, not builds.

The ladder (the agent escalates; the user never picks a tier):

1. Static tree. No sandbox exists. Today's shipped path.
2. Tree + server functions. UI unchanged and instant; buttons and data queries call sandbox functions, which may be stale-while-boot.
3. Server-computed tree. The sandbox returns trees; rendering stays on the instant path, brand-checked and guard-bound. Server brains, pushed face.
4. Served UI. The sandbox serves a real web app; the iframe points at it; iframe `connect-src` is the sandbox origin only, plus manifest egress. Last resort, taken only when the interface itself outgrows trees (npm UI libraries, multi-page). Never a prerequisite for anything.

Invisible graduation is a hard requirement: the user never sees the UI change at a rung jump.

- The tree renderer ships as a library in served-app scaffolds, so a graduated app's first served version renders the identical tree and diverges only on later requests.
- Every app opens on its last state: the live tree at rungs 1 to 3, a dimmed non-interactive screenshot at rung 4 (iOS app-switcher pattern) while the sandbox resumes.
- The old rung keeps serving while the next one builds; the switch is agent-narrated, never silent.

## 6. Versioning

Git-shaped, not git. A version is an immutable content-addressed snapshot of the folder (`sha256:...`). `head` points at the live version; rollback moves the pointer; remix is a fork. Human-facing versions are `v1, v2, ...` and each records the intent (the user instruction that produced it), so history reads as a changelog and enables pin rebases. Real git appears only inside rung-4 sandboxes if the agent chooses; the format never requires it.

## 7. Editing

One loop everywhere: patch, validate, version with intent, rehearse before reality. Two patch dialects, because the material differs:

- Tree edits (`view.json`): structured operations (set prop, wrap nodes, rebind query), validated against the host catalog before applying. Instant, no compile. Trees cannot ship broken.
- Code edits (`components/*.tsx`, `pins/*.tsx`, `server/`): text hunks, compile-checked, contained by error boundaries at runtime. Code fails contained.

Each file type declares its edit dialect and validator. One user instruction may compile to a mix of ops and hunks and lands as one version with one intent. Hand-editing files is a first-class escape hatch; the agent is the default editor, not the only one.

## 8. Permissions: guard owns everything

The manifest carries no permissions. Industry precedent: capability handles plus ask-at-first-use (iOS, OAuth incremental auth, Deno, WASI) over author-declared permission manifests (Android, Chrome extensions), which drift and over-ask. Guard is already the former; the format follows it.

- Apps act only through handed-in capability doors: `vendo.dispatch` in the jail, the server SDK in the sandbox. There is no other path to a tool.
- Guard keeps a grant ledger per app. First call to an ungranted tool triggers the ask in context; the grant is sticky until revoked (existing guard model, keyed by app).
- Publish review shows the ledger: observed truth about what the app actually uses, not author claims. A new version calling a new tool has no grant, so the ask fires by construction (user for personal apps, org admin for published ones). Capability expansion re-approval needs no diffing machinery.
- Away runs (automations) hold only their ledger. An ungranted call fails soft and queues for approval. Grants captured while the user is present are the only authority (page rule).
- Blast-radius warnings join changed tools against ledgers.
- Exports carry zero authority. Optionally a `.vapp` may include an advisory `uses:` list (derived mechanically for trees) as a courtesy label, never enforcement.

## 9. Pins: remixing the product itself

A pin is an edit of the host's actual component source, running in-client after host approval, indistinguishable from shipped product code.

- Host marks a component remixable (opt-in, per file). `vendo sync` captures its real source and dependency closure. Backend code never enters the system.
- A pin is a fork with lineage: the edited source plus `{ slot, base: sourceHash }`. Same editing loop as everything else.
- Rehearsal: before approval, the fork renders only in the furnished jail (captured real sub-components and styles, host-state hooks stubbed with recorded data). Pixel-faithful for look and behavior, simulated at the data seams. The host page never executes unapproved code.
- Approval reviews the net diff against the host baseline, PR-shaped. Approval pins the content hash in the registry. Later edits repeat the cycle while the approved hash keeps serving.
- Mounting: the remixable marking wraps the component in a slot. No approved pin: render the original, near-zero cost. Approved pin: mount the fork in the host's real React tree, imports bound to the real modules (the same imports the jail furnished as copies). Same file, two mounting worlds; approval flips the binding.
- Drift: the host ships a new component version, the pin's base is stale. Keep serving the old approved fork, notify, and the agent rebases recorded intents onto the new baseline, through approval again.
- Failure: an erroring pin falls back to the original component. Stock, never broken.
- Capture depth (dependency-closure rules: what is vendorable, what is stubbed) is the engineering meat of pins and gets its own spec section later.

## 10. Two species, one system

| | App (create from new) | Pin (remix the product) |
|---|---|---|
| Born from | conversation | pointing at a host-marked component |
| Lineage | none | fork of host source, base hash |
| Runs | jailed by default, sandbox rungs | rehearsal jail, then in-client when approved |
| Ship gate | grant ledger review | net-diff review |
| Host updates | irrelevant | drift, rebase, re-approve |
| Failure | own error boundary | slot falls back to original |

The user never chooses a path; "make me something" and "change this" are both conversation. The format routes the trust question to the right shape automatically.

## 11. Security and exfiltration rules

- Remix captures host-marked client components only. Server-side host code is never captured.
- Lineage is export control: host-derived files never leave the host's boundary. `.vapp` export strips pins unless host policy says otherwise. Same-product sharing is fine (recipients' browsers already run that code).
- Jail: no network, no secrets, effects only via guard-gated dispatch. Sandbox: manifest egress allowlist, secrets injected by name, never readable.
- In-client execution replaces the jail with human judgment: small reviewable diffs, hash-pinned approvals, per-version re-review. This trade is explicit.
- Source goes to the host's own BYO LLM provider during editing; note in host-facing security docs.

## 12. Encoding commitments

Named now, designed later (the design is measurement work, not brainstorm work):

- The tree structure is versioned (`vendo/tree@1`).
- A token-compact wire profile of the same structure will exist; readable and compact forms are mechanically convertible. The standard stays readable, the wire stays cheap. Rationale: LLM latency is roughly linear in output tokens (compact UI DSLs measure ~65% token reduction vs markup).
- The payload defines valid-while-partial semantics so renderers stream components as they generate (A2UI precedent: parse and heal partial output).
- Catalog-aware autofix is sanctioned: hallucinated component or prop names correctable against the host catalog without a model round-trip (v0 precedent).

## 13. Deferred

- Compact encoding design and benchmarks.
- Trigger declaration details (automations wave owns them).
- Pin capture-depth rules (own spec section).
- Jail dependency set: fixed blessed kit vs per-host vendored extensions (raised, unanswered).
- Marketplace and cross-org distribution details.
