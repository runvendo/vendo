# @vendoai/apps — the app artifact + the engine that builds and runs them

Status: DRAFT (wave 2). One job: everything Vendo produces and runs is an app (core §9); this block owns the engine that builds them (UI → state → code), the runtime that executes them (tree path + sandbox), the ladder, sharing-as-copy, and pins. Depends on core only; takes an ai-SDK `LanguageModel` for generation. The app-format spec (`docs/superpowers/specs/2026-07-11-app-format-design.md`) is this block's format authority; this contract adds the execution surfaces the spec deferred to wave 2.

## 1. Public API

```ts
import type { StoreAdapter, Guard, RunContext, AppDocument, InstallRecord, ToolSet, ToolOutcome, ComponentCatalog, VendoTheme, SecretsProvider, Tree } from "@vendoai/core";

export function createApps(config: {
  store: StoreAdapter;
  guard: Guard;                         // core seam: lifecycle audit (report), approval resumption (onApprovalDecision)
  tools: ToolSet;                       // ALREADY guard-bound by the umbrella (05 §2) — trees and machines call host tools through it
  sandbox?: SandboxAdapter;             // absent → rungs 2–4 unavailable (VendoError "sandbox-unavailable"); rung 1 fully works
  model?: LanguageModel;                // generation engine; absent → create/edit unavailable, run-only
  catalog: ComponentCatalog;
  theme?: VendoTheme;
  secrets?: SecretsProvider;
  designRules?: string;                 // optional host design rules checked at generation (.vendo/design-rules.md)
}): AppsRuntime;

export interface AppsRuntime {
  // lifecycle
  create(input: { prompt: string }, ctx: RunContext): Promise<{ install: InstallRecord; app: AppDocument }>;
  install(doc: AppDocument, ctx: RunContext, source?: InstallRecord["source"]): Promise<InstallRecord>;  // fresh install: empty data, no grants
  get(installId: InstallId, ctx: RunContext): Promise<{ install: InstallRecord; app: AppDocument } | null>;
  list(ctx: RunContext): Promise<Array<{ install: InstallRecord; app: AppDocument }>>;
  remove(installId: InstallId, ctx: RunContext): Promise<void>;
  fork(installId: InstallId, ctx: RunContext): Promise<InstallRecord>;                                   // forkedFrom set; own copy

  // the edit loop — one loop, two dialects
  edit(installId: InstallId, instruction: string, ctx: RunContext): Promise<EditResult>;                 // conversational
  apply(installId: InstallId, patch: TreePatch | CodePatch, ctx: RunContext): Promise<EditResult>;       // structured (the engine's own path)
  history(installId: InstallId): { list(): Promise<VersionEntry[]>; undo(): Promise<AppDocument> };      // capped log — runtime UX, not format

  // execution
  open(installId: InstallId, ctx: RunContext): Promise<OpenSurface>;
  call(installId: InstallId, ref: string /* "fn:<name>" | tool name */, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  runQueries(installId: InstallId, ctx: RunContext): Promise<Record<string, Json>>;                      // refresh a tree's data model

  // interchange (spec §6: copies, never pointers)
  exportApp(installId: InstallId, ctx: RunContext): Promise<Uint8Array>;    // .vendoapp; pin permission check — fails, never strips
  importApp(bytes: Uint8Array, ctx: RunContext): Promise<InstallRecord>;

  // ☁️ Cloud shapes (impl throws "cloud-required" without VENDO_API_KEY)
  share(installId: InstallId, ctx: RunContext): Promise<ShareSnapshot>;
  publish(installId: InstallId, ctx: RunContext): Promise<PublishRecord>;

  /** Vendo capability tools (vendo.apps.create, vendo.apps.edit, vendo.apps.open) for the agent loop —
   *  registered into actions by the umbrella, guard-treated like everything else. */
  agentTools(): ToolSet;
}
```

```ts
export interface EditResult { app: AppDocument; version: VersionEntry; issues?: string[] }
export interface VersionEntry { at: IsoDateTime; intent: string; rung: 1 | 2 | 3 | 4 }
export type OpenSurface =
  | { kind: "tree"; tree: Tree; components?: Record<string, string> }          // rungs 1–3: the live tree
  | { kind: "http"; url: string; cover?: string /* blob key of last screenshot */ }  // rung 4, machine awake
  | { kind: "resuming"; cover?: string }                                       // rung 4, snapshot waking (~1s): dimmed screenshot, non-interactive
export interface ShareSnapshot { id: string; doc: AppDocument; createdAt: IsoDateTime }        // frozen copy
export interface PublishRecord { id: string; appId: AppId; version: string; createdAt: IsoDateTime }
```

## 2. The ladder (normative invariants)

1. **Tree only** — instant, jailed (`connect-src 'none'`), no machine.
2. **Tree + server** — UI unchanged; queries and actions with `fn:` refs call the machine.
3. **Server-computed tree** — `POST /fn/<name>` returns a tree document; rendering stays on the instant path.
4. **`ui: "http"`** — the machine serves a real web app. Last resort; never a prerequisite.

The agent escalates; the user never picks a tier. **Invisible graduation** requirements on this runtime: `open()` always answers from last state (live tree, or cover screenshot while resuming); the tree renderer ships as a library in served-app scaffolds so the first served version renders the identical tree; the previous rung keeps serving while the next builds (escalation happens in a fork of the machine/document, swapped on success).

Edit dialects: **tree edits** are structured ops validated against the catalog — a completed tree cannot ship broken; **code edits** are text hunks, syntax-checked, contained by error boundaries.

```ts
export type TreePatch = Array<
  | { op: "set-prop"; nodeId: string; prop: string; value: Json }
  | { op: "insert-node"; node: TreeNode; parent: string; index?: number }
  | { op: "remove-node"; nodeId: string }
  | { op: "move-node"; nodeId: string; parent: string; index?: number }
  | { op: "set-data"; path: string; value: Json }
  | { op: "set-query"; query: TreeQuery }
>;
export interface CodePatch { file: string; hunks: Array<{ find: string; replace: string }> }   // component source or machine files
```

## 3. Sandbox adapter seam ⚑ (lives here; e2b + Modal adapters in-box)

BYO provider key in OSS; Vendo Cloud is a zero-config hosted adapter behind the same interface. No Vendo-built runner, no local Docker tier.

```ts
export interface SandboxAdapter {
  create(spec: { env: Record<string, string>; files?: Record<string, Uint8Array | string> }): Promise<SandboxMachine>;
  resume(snapshotRef: string): Promise<SandboxMachine>;    // "e2b:snap_x91" — provider-prefixed, opaque past the colon
}

export interface SandboxMachine {
  id: string;
  /** Proxy an HTTP request to the app's $PORT. The only way UI/functions/triggers reach the app. */
  request(req: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array | string }):
    Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;  // the agent edits inside the machine
  files: { read(path: string): Promise<Uint8Array>; write(path: string, bytes: Uint8Array | string): Promise<void>; list(dir: string): Promise<string[]> };
  snapshot(): Promise<string>;           // re-snapshot after edits → the app document's `server` field
  screenshot?(): Promise<Uint8Array>;    // rung-4 cover; optional capability
  stop(): Promise<void>;
}
```

Subpath exports: `@vendoai/apps/e2b` → `e2bSandbox({ apiKey })`, `@vendoai/apps/modal` → `modalSandbox({ tokenId, tokenSecret })`.

## 4. The server execution contract (Yousef-approved: plain HTTP paths)

The machine IS the server part. No declared entry point; by convention the app listens on `$PORT` and everything arrives as requests.

### 4.1 Reserved paths

| Request | Meaning | Response |
| --- | --- | --- |
| `POST /fn/<name>` body `{ "args": {...} }` | function call (rungs 2–3) | `200 { "result": ... }` — or a body whose `formatVersion` is `vendo-genui/v1` = a server-computed tree (rung 3) |
| `POST /trigger` body `{ "trigger": Trigger, "event": {...}, "runId": "run_..." }` | a trigger firing delivered to the app (07 §4) | `200 { "result": ... }` (recorded on the run) |
| anything else | the served web app — rung 4 only | app-defined |

`fn:` resolution: a tree's `fn:<name>` reference (core §8) resolves to `POST /fn/<name>` on this app's machine, args from the query/action. Function errors are `{ "error": { "code", "message" } }` with appropriate HTTP status; the renderer contains them (error boundary / stale data notice), never breaks the surface.

### 4.2 Run environment (injected at machine create/resume)

| Variable | Contents |
| --- | --- |
| `PORT` | where the app must listen |
| `VENDO_PROXY_URL` | the runtime's tool proxy for this run (§4.4) |
| `VENDO_RUN_TOKEN` | bearer token scoping this run: `{ installId, principal, runId, presence }` — minted per run, short-lived |
| `VENDO_INSTALL_ID` | this install |
| declared secret names | **handles**, not values (§4.3) |

### 4.3 Secrets ⚑ — handles, substituted at egress

Per the page, secret values are never readable by app code. Each declared secret name is injected as an opaque handle (`vendo-secret:<name>:<nonce>`). The machine's egress proxy (which also enforces the `egress` allowlist) substitutes the real value when a handle transits toward an allowlisted domain (headers or body). App code uses `process.env.STRIPE_KEY` normally and never learns the value; a handle leaving toward a non-allowlisted domain never resolves. Values come from the composition's `SecretsProvider`.

### 4.4 Host tools from inside the machine (the capability axis)

App backend code always runs in the server sandbox and never holds authority (the one security rule). It reaches host tools only back through guard:

```
POST {VENDO_PROXY_URL}/tools/<name>
Authorization: Bearer {VENDO_RUN_TOKEN}
body: { "args": {...} }        →  ToolOutcome (core §4)
```

The proxy resolves the token to its `RunContext` and calls the guard-bound registry — identical treatment to a chat tool call. Away + ungranted → `{ "status": "pending-approval" }`; the app must tolerate it (fail soft).

## 5. Generation engine

`create`/`edit` drive the model with: the catalog (host components by name + schemas), theme, optional design rules, and the format's caps. Streaming: partial trees render as they generate (dangling children = skeletons); fast edits patch rather than regenerate. On-brand is a hard goal: host components preferred over generated ones whenever the catalog covers the need. (Compact encoding, valid-while-partial semantics, catalog-aware autofix: reserved, core §8.)

## 6. App data

`storage` declarations (core §9) map to store collections `app:<installId>:<name>` — per install, per the one security rule (data belongs to the user's install, never the artifact). `state` is the built-in singleton: one free-form record per user per app, zero declaration, read/written via `vendo.state` get/set on the tool proxy and the tree's `$state` bindings persistence hook. `refs` typed as `host.<entity>` make records joinable onto host tables (02 §2). `kind: "files"` collections land in the blob store.

## 7. Interchange (spec §6)

- `exportApp` → `.vendoapp` zip: `app.json` (the document) + `app/` (the machine's app directory, pulled from the snapshot, when one exists). No data, no caches, no grants, no snapshots. Pins: host-derived source exports only with host permission (`remixable` components carry an exportable flag in the captured baseline); a forbidden pin **fails the export** — never silently strips.
- `importApp` → validate document, fresh install (empty data, no grants), spin a fresh machine from `app/` if present (create → write files → snapshot → set `server`).
- `share`/`publish` (Cloud): both hand over a **copy**; publishing routes it through the org registry with admin-approved capability expansions. Shapes here, machinery in the cloud repo.

## 8. Pins (spec §5)

A pin is an edit of the host's actual component source, mounted in the product after host approval.

```ts
export interface PinBaseline { slot: string; source: string; hash: string; exportable: boolean; capturedAt: IsoDateTime }   // .vendo/remixable/<slot>.json, captured by sync (04 §1)
export interface PinShipRequest { installId: InstallId; slot: string; baseHash: string; diff: string /* unified */ }
export interface PinApproval { slot: string; baseHash: string; approvedHash: string; approvedBy: string; at: IsoDateTime }
```

Flow (normative): host marks a component remixable (opt-in, per file) → sync captures its real source (backend code never captured) → the user edits a fork conversationally, rehearsed in the furnished jail (real sub-components and styles, stubbed data) while the product keeps running the original → shipping sends the net diff against the host baseline for approval → the approved copy is held by the host registry, pinned to its hash; the host page never executes unapproved code → approved pins mount natively with full host-page authority (the diff review is the control) → a host update to the component marks the pin drifted; the agent rebases recorded intents onto the new source, through approval again → an erroring pin falls back to the original at runtime. Pin registry storage + serving: host-side, via store; client mounting: ui (08 §5). ☁️ Pinning itself is Cloud (rides publishing).

## 9. In-client venue (the trust axis)

UI runs in the sandboxed iframe by default → in the host page only when host-approved. Approval pins the content hash; new versions re-approve.

```ts
export interface InClientApproval { appId: AppId; versionHash: string; approvedBy: string; at: IsoDateTime }
```

Host adoption never moves backend code into the host's servers — §4.4 stands regardless of venue.
