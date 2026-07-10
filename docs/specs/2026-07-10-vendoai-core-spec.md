# @vendoai/core — Specification

**Status:** Draft v3 for review · **Date:** 2026-07-10 · **Track:** 1 of the standalone-blocks re-architecture
**Sources of authority:** the Open-Source Full-Stack Agentic Interface PRD (Notion), decisions locked in the 2026-07-09/10 design session, `docs/specs/research-2026-07-framework-landscape.md` (version-stamped ecosystem facts).
**Reviews incorporated:** two rounds. Round 1 — Codex (gpt-5.5) + Fable. Round 2 — Codex architecture lens + Codex adversarial-security lens + Fable fresh review. All accepted findings folded in; speed research (`research-2026-07-module-speed.md`, `research-2026-07-apps-speed-capability.md`) checked for contract impact (none beyond noted footnotes).
**Altitude note:** this is a high-level contract spec. Deep security *mechanisms* (signing schemes, replay-nonce protocols, transactional-mint internals) are named as invariants here and designed by the owning track — the spec states the requirement and the fail-closed behavior, not the implementation.

---

## 1. Goals & non-goals

`@vendoai/core` is two things and nothing else:

1. **The shapes everything speaks** — tool descriptors + risk labels, principal, the module envelope + seal, permission grants + provenance, storage slice contracts, theme tokens, the module↔host protocol. A shape earns a place in core only if **two or more blocks (or the host) must agree on it**; anything used by exactly one block belongs to that block.
2. **The module runtime** — sandboxed execution of modules (browser iframe now, server sandboxes later), so `@vendoai/apps` and `@vendoai/automations` are thin engines on top with **no peer dependencies**.

**Non-goals.** Core never talks to an LLM, never renders chrome, never persists anything itself (contracts only), never depends on another `@vendoai/*` package, and carries no framework dependency — `ai` and `@ai-sdk/provider` leave its dependency list. Blocks depend on core; core depends on `zod` and the platform.

**Release model.** One version train: all `@vendoai/*` release together. This re-architecture ships as a big-bang `0.3.0`; old contracts are deleted, no compat shims (no external consumers yet).

## 2. Package layout

One package, subpath exports:

```
@vendoai/core             # contracts: tools, principal, module envelope, grants,
                          #   storage slices, theme, protocol types (deps: zod only)
@vendoai/core/runtime     # module runtime: workspace, bundler, MCP Apps host bridge,
                          #   sandbox providers seam (vendo-stage + vendo-sandbox-shims fold in)
@vendoai/core/adapters    # framework interop: Standard Schema helpers, ingestion
                          #   (fromAiSdkTools, fromMcp), exporters (toOpenAiAgentsTools, …)
```

`vendo-stage` and `vendo-sandbox-shims` cease to exist as packages. **Dependency budget (review finding), made enforceable:** the root export depends on `zod` only. `/runtime`'s heavier machinery (esbuild, git plumbing, sandbox providers) and `/adapters`' framework converters are **optional peer dependencies with injected providers** — core references them through seams, never a hard import. A **CI test installs the package with only `zod` present and imports the root + `/adapters` type surface**, failing if either drags in framework or sandbox machinery. So importing a contract type can never install or load a bundler, a git library, or an AI SDK.

The umbrella `vendoai` package (separate track) offers `createVendo({ database })` composition sugar. It is **config-holding only**: every call literally delegates to a block's own `create*`. The umbrella must never add behavior of its own.

## 3. Tool contract

The neutral shape every block speaks — no framework imports anywhere:

```ts
interface ToolDescriptor {
  name: string;                              // model-facing identifier  ^[a-zA-Z][a-zA-Z0-9_-]*$
  title?: string;                            // human display name (cards, audit)
  description: string;                       // drives LLM tool selection
  inputSchema: JsonSchemaDocument;           // plain JSON Schema (wire format)
  outputSchema?: JsonSchemaDocument;
  risk?: "read" | "write" | "destructive";   // HOST-OWNED, versioned (§3.1); undeclared/unknown-external ⇒ destructive
  idempotent?: boolean;                      // "safe to retry?" — automations read this
  binding?: ToolBinding;                     // how it reaches the host API (http | … extension point)
  formats?: Record<string, FieldFormat>;     // display hints (cents, iso-date, …) — carried over
  meta?: Record<string, unknown>;            // namespaced extension point (like MCP _meta)
}

// The AUTHORING shape — a tool as a block defines it. NOT itself a framework tool.
interface UnboundVendoTool {
  descriptor: ToolDescriptor;
  execute(input: unknown, ctx: ToolCallContext): Promise<ToolOutcome>;
}

interface ToolCallContext {
  principal: Principal;
  provenance: CallProvenance;                // §7 — who/what initiated this call
  toolCallId: string;
  signal?: AbortSignal;
}

// Three outcomes — the "pending" arm is a core contract (review finding): guard can
// answer "ask", and unattended runs PARK. Every consumer (framework loop, Python
// module, automation runner) must be able to represent "not resolved yet".
type ToolOutcome =
  | { ok: true;  result: unknown }
  | { ok: false; error: { code: string; message: string } }
  | { ok: false; pending: { kind: "approval" | "parked"; ref: string } };
  //   ↳ the call is held; `ref` correlates the eventual resume (consent response
  //     or parked-action resolution). The framework/runtime bridge decides how to
  //     surface it (HITL data part, park notification) — §3.2, §7.
```

**Binding vs framework shape (review finding).** `UnboundVendoTool` is the shape blocks author; it is deliberately *not* a Vercel/Mastra tool (it nests metadata under `descriptor` and takes our `ToolCallContext`). The framework-shaped object is what **`toToolSet(tools, { principal, provenance })` emits** — a `BoundToolSet` whose per-tool `execute(input, frameworkOpts)` closes over the bound context and the guarded pipeline. The CI assignability test (§3.2) targets the `BoundToolSet` output, not `UnboundVendoTool`.

### 3.1 Risk labels

One vocabulary replaces both of today's (`{mutating, dangerous}` manifest booleans and the runtime's `read/act/critical` tiers):

| Label | Runtime behavior |
|---|---|
| `read` | auto-runs (the egress jail is what makes this safe — see §6 invariant I1) |
| `write` | asks until granted; grants can suppress |
| `destructive` | **always asks — no grant, fade, or rule may ever suppress** ("money always needs you") |
| *(undeclared)* | treated as `write` **plus an orthogonal `unverified` flag**, surfaced on cards and the Trust screen |

MCP ingestion is lossless: `readOnlyHint → read`, `destructiveHint → destructive`, `idempotentHint → idempotent`. Approval-need is **Vendo metadata enforced by guard server-side** — never delegated to a framework field (Vercel v7 deprecated per-tool `needsApproval`; we deliberately do not couple). The ladder deliberately stays three levels; finer policy dimensions (data sensitivity, external exposure, unattended-run eligibility) are guard-track policy inputs, not core shapes (review ruling).

**Labels are host-owned facts, not model opinions (security review).** A risk label is a security fact the whole ladder rests on, so: it is **host-declared and versioned** (part of `tools.json`, feeds the seal §5.1); the agent can never author or lower it; an **unknown/unlabeled external tool defaults to `destructive`** (fail-safe, not `write`); and the label is a *policy input evaluated server-side at the binding endpoint*, not merely a UI hint — a mislabeled tool must not become the only thing standing between an automation and a destructive call. Descriptor drift in a label lapses grants via the seal.

### 3.2 Framework interop (the "user never worries about it" design)

**Our tools ARE valid Vercel AI SDK tools, structurally.** Verified against their source: `tool()` is an identity function, `ToolSet` is a plain record, and `inputSchema` accepts any object implementing Standard Schema (validate) + Standard JSON Schema (converter). `createTool()` attaches those fields to every `VendoTool`.

**Per-request principal binding (review finding — contract-level).** Frameworks never pass `principal`/`provenance` to `execute` — their option bags don't know these concepts. So the export step is where identity binds, per request, in the host's route handler:

```ts
// app/api/chat/route.ts — the flagship path, honestly shown:
const principal = await identify(req);                          // host session → Principal
const tools = toToolSet(safe, { principal, provenance: { kind: "chat" } });
return streamText({ model, tools, messages }).toUIMessageStreamResponse();
```

`toToolSet` closes each tool's `execute` over the bound context and the guarded pipeline; an `UnboundVendoTool` is never handed to a framework un-bound (calling its raw execute without context is a contract error). The same bound objects flow into Mastra unchanged; OpenAI Agents gets a thin exporter (`toOpenAiAgentsTools` — their SDK parses but does not validate JSON Schema inputs, so the exporter attaches our validation). **A CI test asserts the `BoundToolSet` output stays assignable to Vercel's `Tool`/`ToolSet` types on every SDK release.** If a Vercel major ever breaks duck-typing, the fallback is one converter call for that major; our contracts don't move.

**Where a "please approve" reaches the UI when you use guard ALONE (review finding).** If a dev adopts only `@vendoai/guard` on a stock Vercel app (no `@vendoai/agent`), a guarded tool that returns the `pending` outcome must still surface a card. The bound tool renders `pending` onto the framework's own HITL channel — for the ai SDK, `toToolSet` emits the tool-approval-request the SDK already understands (`useChat().addToolApprovalResponse` answers it); `/adapters` ships the small bridge that maps a Vendo consent request ↔ that native mechanism. So guard-standalone works with stock `useChat` and no bespoke UI; richer consent cards are an `@vendoai/agent`/ui upgrade, not a requirement. Frameworks without a HITL channel get a documented data-part convention instead.

**Ingestion — the other direction (more important for adoption):**

```ts
const theirs = fromAiSdkTools(existingTools, {
  risk: { deleteInvoice: "destructive", listInvoices: "read" },   // one-line annotation
});
const safe = guard([...theirs, ...actions], { database });        // guard polices THEIR tools too
```

`fromAiSdkTools` derives descriptors mechanically (zod → JSON Schema via the SDK's own converter); risk can't be derived from code, so undeclared → `write` + `unverified` with the override map as the fix. `fromMcp` maps annotations losslessly. Industry precedent: neutral catalog + per-framework edges (Composio, Arcade); `ToolDescriptor` is deliberately ~an MCP tool.

The **streaming/genui message protocol stays ai-SDK-typed** (UIMessage + data parts) as the one documented framework-coupled surface, contained in `@vendoai/agent` (not in core's contracts), with MCP Apps as the standards-based escape hatch.

## 4. Principal

```ts
type Principal =
  | { kind: "user"; tenantId: string; subject: string; claims?: Record<string, unknown> }
  | { kind: "anonymous"; sessionId: string; tenantId?: string };   // tenantId: multi-tenant hosts scope guest sessions
```

Every storage operation and policy decision is principal-scoped. Anonymous is a first-class, *visible* state with contract-level rules:

- **Non-persistence is structural, not prose** (review finding) — core ships `withAnonymousGuard(storage)`, applied by every block's `create*`, routing anonymous-principal operations to an ephemeral layer with defined expiry/cleanup, so third-party storage implementations cannot get this wrong (§10).
- **Session identity is defined, not hand-waved** (review finding). `sessionId` is minted by core's request helper on first contact (an httpOnly cookie by default; hosts may supply their own opaque id). "Session end" = cookie expiry or an explicit `endSession`; on a stateless HTTP host the ephemeral layer is keyed by `sessionId` with a TTL (default 24h, host-configurable), and expiry is what reaps anonymous grants/modules/state. There is no durable identity to leak into.
- **Anonymous is least-privilege by default** (security review). Anonymous principals get `read` tools only; `write`/`destructive` tools, module sharing/import, and automations are **off unless the host explicitly opts them in per tool**, under strict rate/resource quotas. This bounds the public-facing abuse surface (spam, write-tool farming, resource exhaustion) that session-scoping alone does not.

This is what makes `vendo init` work in the first ten minutes (before identity wiring) and honestly serves guest-user products. Hosts must never mint fake-permanent subjects for anonymous traffic.

## 5. Modules

### 5.1 What a module is

**A module = a git repo of ordinary files + a system-written envelope.** Saved views, remixes, and scheduled micro-apps are the same artifact with more or fewer files. Nobody — human or AI — authors a manifest:

```
modules record (envelope — ALL system-written):
  id, name, provenance                            ← storage/system-assigned
  trigger, anchor                                 ← captured from conversation at save
  egress, secrets                                 ← derived from files, confirmed on the save card
  repo                                            ← bare git repo: THE artifact
  version = SEAL                                  ← see below
```

**The module seal (review finding — replaces bare commit-sha versioning).** What a user approves is not just code; it's code + the envelope's security posture + what the named tools actually do. Two derived keys, because approval and caching have different sensitivities (review finding — they were conflated in v2):

```
buildKey    = hash( repo commit sha + canonical envelope )          // what to compile/run — cache key
approvalSeal = hash( buildKey + descriptor hashes of every host tool the module was approved to use )
```

- **Caches** (compiled bundle, warm snapshot) key on `buildKey` — a host tweaking one tool's *description* must not invalidate every module's compiled artifact.
- **Grants and audit** bind to `approvalSeal` — so drift in a granted tool's behavior *does* lapse the approval even though no file changed. Any envelope security edit (widened egress, retimed trigger), any repo change, and any granted-tool descriptor drift **lapses the grants and re-prompts** — closing the "edit the trigger to every-minute without touching code" hole.

**No time-of-check/time-of-use gap (security review — invariant I8).** The seal a user approves is immutable; grant minting is compare-and-set against that exact seal, and every run/build/cache read must prove the same seal or **fail closed**. A repo/envelope/descriptor mutation between save-card and mint (or a stale warm snapshot from a superseded seal) can never be executed under the old approval.

Everything else lives **in the files, in each ecosystem's own standard formats** — `requirements.txt`, `package.json`, `Procfile`, `Dockerfile`. We infer how to run a repo buildpack-style (delegated to an existing OSS builder — Nixpacks or CNB, runtime track picks); we never define our own execution manifest.

### 5.2 Capability tiers (emergent, not declared)

The ladder is a property of what's in the repo; one module can climb it in place (same id, same grant lineage, new seal):

```
view.json                → declarative UI tree of host components: instant render,
                           no sandbox, no code risk, cheapest AI generation (default tier)
index.tsx / index.html   → custom web UI: esbuild-bundled, sandboxed iframe, MCP Apps
main.py / Procfile / …   → full micro-app: server sandbox, any language Linux runs
```

`ui` entries are web tech (iframe physics). Service code is anything. The agent defaults to the cheapest tier that satisfies the request and escalates only when asked. Speed-research note for the apps track: the `view.json` schema must be designed **streaming-first** (identity/skeleton keys before heavy children) so views paint while they generate.

### 5.3 The lifecycle (scoop → store → pour)

1. **Workspace.** The agent works in a runtime-owned sandbox directory — every file write goes through the runtime, so capture never trusts model claims.
2. **Scoop (save).** The runtime captures the working tree into the repo, excluding reproducible artifacts (rule: *capture the recipe, never the reproducible artifact* — the exclusion set and lockfile-freezing behavior are a runtime-track detail); oversized captures surface on the save card instead of silently storing.
3. **Derive.** Static analysis over the captured files: tool calls used, external hosts → egress candidates, entry detection. **Derivation is UX, not security** — it feeds the save card; enforcement is always runtime (§7). A missed call = friction (parked + ask), never breach.
4. **The save card — the single human beat.** "Invoice Chaser: runs Mondays 9am · reads invoices · **sends reminder emails** · no internet access — Save & allow?" Minting seal-bound pre-approval grants happens here.
5. **Pour (run).** Materialize the repo into the right placement; warm snapshots make it instant (§8). Tier-3 builds run async at save time so first fire is warm (speed-research note).
6. **Export/share.** `git bundle` + envelope = one portable file (`.vendomodule`); import pours it back on any Vendo install. Sharing shows the receiver the same derived card before accepting; their grants, their scoping. Share/import integrity shapes are core contracts (security review): a **signature covers the canonical repo bundle + envelope + seal + signer identity**; import **verifies signature, signer chain, and revocation/advisory status BEFORE presenting any grant card**, and **fails closed** (offline/unverifiable ⇒ import is blocked or explicitly quarantined read-only, never silently trusted). The registry, key model, and advisory feed implementing this at scale are cloud-track; core defines the shapes and the fail-closed rule.

**Deleted from earlier drafts, deliberately:** the authored manifest, the `capabilities` tier enum, the static tools allowlist (→ §7), the bespoke files-map format, the bespoke capture pipeline and export format (git does all four), the `dependencies`/`entries` manifest fields (ecosystem files do it).

### 5.4 Two homes, one format

Dev-shipped modules live as folders in `.vendo/modules/` (ordinary files; optional tiny `vendo.json` for trigger/egress — devs like config files; agents never write one), packed by `vendo sync` into the same envelope+repo shape. **Sync commits must be deterministic** (fixed author/epoch timestamp, or tree-hash-based versioning) so re-syncs and deploys of unchanged modules never mint a new seal and spuriously lapse grants (review finding). User/agent modules are born as database rows. Provenance records which (§7).

### 5.5 Anchored modules (remixes)

`anchor` is an envelope field: which host page spot the module binds to, plus remix bookkeeping (source hash, envelope/seal refs, edit baseline hash) in one labeled corner. Anchored modules receive live host props (`vendo/anchor-data`, §9) **and may still do anything a module can** — no special identity, no capability restrictions in core (hosts restrict via policy if they want). Which module is pinned at which anchor is a separate tiny mapping owned by the apps block, so several saved remixes of one spot can exist with one active.

### 5.6 Storage split (truth / cache / never-ours)

| | What | Where |
|---|---|---|
| **Truth** | envelope + repo · big assets · module state · grants · run history · audit | storage slices (§10) |
| **Cache** (evict freely) | compiled iframe bundle (by `buildKey`) · warm sandbox snapshots with deps installed (by `buildKey`, provider-owned) | runtime/provider |
| **Never ours** | host business data (reached only via host tools) · host/shared-module secret values (I4 handle-mode: injected only at the egress proxy, never in module code) | host systems / secrets slice |

Invariant (the test the design must keep passing): **delete every sandbox and every cache; every module still works from its repo.**

## 6. Threat model & security invariants (review finding — new section)

The permission model's claims rest on these. Each is a **contract requirement** on the runtime — testable, not aspirational. An implementation that cannot uphold one must not claim conformance.

- **I1 — Network deny-all.** Module environments have no network except envelope-declared egress, enforced at the platform layer (iframe CSP per the MCP Apps standard; VM-level network policy server-side). This is the invariant that makes `read` auto-run safe.
- **I2 — Unforgeable provenance.** `CallProvenance` is attached at the trust boundary appropriate to the placement: server/module calls are stamped by the runtime *outside* the sandbox (module code cannot set, omit, or alter it) and verified against the per-run credential (I3); interactive chat calls are stamped in the host route handler by `toToolSet` (trusted server code the module never touches). Calls reaching guard without a boundary-attached provenance are rejected.
- **I3 — Per-run credentials.** Server-placed runs execute under a runtime-minted credential bound to (principal, module id, seal, run id) with expiry. Tool endpoints reject calls not bearing it — a sandbox cannot call on behalf of anyone else, or outlive its run.
- **I4 — Secrets are provenance-gated** (security review — the v2 "injected but never readable" wording was self-contradictory). The trust boundary is *secret owner vs. code author*, matching industry norm (Zapier/n8n hand a user their own key; CI/secret-managers give untrusted code only references):
  - **Owner is the acting user AND the module is self-authored** → the raw value may be injected into the module's environment (your key, your automation — like Zapier). Frictionless common case.
  - **Host-owned secret, OR any `shared`/`imported` module** → the module gets an **opaque handle** only; the real value attaches at the egress proxy *outside* the sandbox, so the code can never read, log, transform, or exfiltrate it. No opt-out.
  - Which rule applies is decided by (secret owner, module `origin`), enforced by the `secrets` slice (§10) — never a global switch. Secrets never enter the repo, bundle, or logs in either mode.
- **I5 — Write-tools are egress, and grants must bound them** (security review). The jail (I1) blocks the network, but a granted `send_email` can carry stolen read-data in its payload. Therefore a pre-approval grant on a write tool MUST carry enforceable **argument constraints** (recipients/domains/fields/volume — the grant-constraint machinery already in the contract); a write whose material payload is not knowable at save time is **not pre-approvable** and parks per instance. Consent cards MUST surface material payload fields (never a blind "allow send_email"); guard applies elevated scrutiny to write-calls following broad reads when `origin: "shared"`.
- **I6 — Resource limits.** Sandboxes run under CPU/memory/time budgets; exhaustion kills the run and audits it. Budgets are host-configurable, never absent.
- **I7 — Audit completeness.** Every tool call, parked action, grant mint/lapse, share-accept, and secret injection produces an audit row with principal + provenance + seal. No configuration can disable audit.
- **I8 — Seal is immutable, mint is fail-closed** (security review; see §5.1). No time-of-check/time-of-use gap between what a user approves and what runs; compare-and-set mint, stale-snapshot rejection.
- **I9 — The module↔host bridge is capability-bound per render** (security review). Each rendered view gets a per-render capability/nonce; the host binds messages to a strict `targetOrigin` + source window + (seal, principal, render id) and rejects spoofed, replayed, or nested-frame-originated messages. (Mechanism owned by the runtime track; the invariant is core's.)
- **I10 — Host-pushed data is tainted input** (security review). `vendo/anchor-data` and any host data entering a module or the generation context is untrusted: it is audit-logged, may be sensitivity-tagged, and **must never be treated as instructions** to the agent or module. Writes following anchor-data exposure get I5 scrutiny — this is the prompt-injection path.

## 7. Permissions

One permission layer, module-aware. **No parallel static allowlists** — a module may *attempt* any tool its user can reach; enforcement happens on every call, server-side, in guard.

```ts
interface CallProvenance {
  kind: "chat" | "module" | "automation";
  moduleId?: string;
  seal?: string;                                        // version binding (§5.1)
  origin?: "dev-shipped" | "self-generated" | "shared"; // trust class
}
```

- **Provenance rides every call** (attached per invariant I2). Policy sees who's really asking; audit records "sent by invoice-chaser (shared by Sarah)," never just "sent."
- **Grants gain an optional context scope.** A chat-minted grant never auto-suppresses prompts inside someone else's shared module; "always allow *for this module*" is a grantable answer. The existing grant record design (structured scope, constraints, durations, descriptor-hash lapsing, store-assigned identity) carries over intact plus the scope dimension.
- **Automation pre-approvals are the same grants**, minted at save time from the derived summary, **seal-bound** (§5.1), re-prompted on any edit. No second pre-auth system.
- **Unattended runs never prompt mid-run:** an unexpected call **parks** — the action is held, the rest of the run proceeds where safe, the user is notified ("Chaser wants `delete_invoice` — it never asked for this. Allow?"). **Approving a parked action releases that one instance only**; the card offers a separate explicit "always allow for this module" choice that mints a scoped grant (decision 2026-07-10). **The card is rendered from host-owned canonical tool metadata** (name, risk, exact arguments/diff, origin, seal) — never from strings the module supplies — so a module cannot social-engineer a misleading one-click approval (security review). "Always allow" is **not offered for a `destructive` parked action** (it stays non-suppressible). Denial drops the action; both outcomes are audited.
- **Risk ladder is the gate** (§3.1); `destructive` is never suppressible by anything.
- **Dev-shipped modules** (`origin: "dev-shipped"`) still run under the same permission layer — being in the repo is not blanket authority. The host chooses their grant lifecycle: per-user first-use consent (default) or a host-level pre-trust policy for modules it code-reviewed. Either way, `destructive` calls remain non-suppressible.
- **Anonymous principals:** session-duration grants only; no pre-approvals (nothing outlives the session); read-tools only unless the host opts in per tool (§4).
- **What stays static in the envelope** (sandbox-construction *physics*, not permission *policy*): `egress` (→ invariant I1; deny-all default) and `secrets` (→ invariant I4).

Core owns the shapes (grant, provenance, verdict, seal); guard owns the pipeline (policy evaluation, consent ceremony, fade, judge).

## 8. Module runtime (`@vendoai/core/runtime`)

```ts
interface ModuleRuntime {
  render(module: ModuleRef, opts: RenderOptions): Promise<ModuleView>;   // browser placement
  execute(module: ModuleRef, opts: ExecuteOptions): Promise<RunResult>;  // server placement
  workspace(principal: Principal): Promise<ModuleWorkspace>;             // agent's build/scoop surface
}

interface RenderOptions {
  tools: VendoTool[];        // all tools the user can reach — guard polices per-call
  principal: Principal;
  theme: ThemeTokens;
  anchorData?: unknown;      // live host props for anchored modules
}
```

**Placement boundary (review finding — keep apps out of core).** Core's runtime owns repo materialization, the sandbox/iframe + MCP Apps transport, CSP construction, and the provider seams. It does **not** know host components: `view.json` rendering is an **apps-owned renderer injected into the runtime** (`runtime.render` accepts a view-renderer plugin), so `@vendoai/core/runtime` never imports the component library and the block boundary stays honest.

**Browser placement:** `view.json` present → the injected apps renderer paints host components directly, no sandbox boot. Otherwise: esbuild bundles the web entry into one HTML document (import maps vendor React + the component library — never re-bundled per module) → different-origin double-iframe with host-constructed CSP from `egress` (I1) and per-render capability binding (I9) → MCP Apps handshake. Compiled output cached by `buildKey` (§5.1); reopen is instant.

**Server placement (provider seam):** `SandboxProvider` interface; E2B and smol-machines-style self-hosted microVMs are the candidate first implementations (runtime track decides with a maturity check — the self-hosted option exists so OSS never *requires* a hosted account). Nixpacks/CNB infers the build; warm snapshot/resume is the **provider's** feature, keyed by seal. Injected into every server sandbox: the MCP tool endpoint (language-agnostic tool calls — Python imports a client, bash gets a `vendo call` shim) guarded by the per-run credential (I3), secrets (I4), and the state client. Sandbox filesystem is disposable by contract; durable data goes through `vendo/state`.

Both placements attach provenance to every call (I2). The three flows the runtime wires end-to-end: **save** (workspace → commit → derive → card → grants → envelope+seal), **render** (envelope+repo → bundle → iframe → MCP Apps → guard → host API), **fire** (scheduler → pour → run → MCP → guard → host API → audit + toast).

## 9. Module↔host protocol: MCP Apps, natively, everywhere

Our surfaces are conforming **MCP Apps** hosts (extension `io.modelcontextprotocol/ui`, Stable 2026-01-26; plain MCP JSON-RPC over postMessage). From the standard, verbatim: `ui/initialize` handshake, `tools/call` from the view, streaming tool input/results, display modes, resize, teardown, host context (theme/locale/timezone), CSP assembled by the host from declared domains (deny-all default; host may tighten, never loosen). The bridge is capability-bound per render (I9).

**Portability is a matrix, not "zero translation"** (review finding — the v2 claim was too strong):

| Module surface | ChatGPT/Claude/VS Code/ai-SDK hosts |
|---|---|
| HTML-tier module using only standard MCP Apps | Renders as-is, no translation |
| Module using `vendo/state` or `vendo/anchor-data` | Feature-detected via handshake capabilities; **degrades gracefully** (e.g. renders read-only) |
| `view.json`-tier module | **Host-only** — needs the host's component library; does not render externally |

Rationale for the bet: one protocol inside and outside the product; the common HTML tier travels for free.

**Two namespaced Vendo extensions** (the standard's designed extension mechanism), owned by core:

- `vendo/state` — get/set persisted module state (the standard defers persistence); backed by the `state` slice; session-scoped for anonymous principals. Migrates to the standard's persistence when it lands.
- `vendo/anchor-data` — live host-props push for anchored modules (audit-logged per I5).

**Portability is honest, not absolute** (review finding): modules relying on `vendo/*` extensions MUST feature-detect via the handshake's `appCapabilities`/`hostCapabilities` and degrade gracefully in non-Vendo hosts (a stateful module renders read-only in ChatGPT rather than breaking). `view.json`-tier modules render only where the host component library exists — i.e., inside the host product.

Single-HTML-document delivery is a build step, not a capability ceiling (a bundled SPA routes internally; heavy compute lives in service code reached via tools).

## 10. Storage contracts

Per-concern slice interfaces in core; `@vendoai/store` implements all; any block accepts custom implementations. Config key: **`database`** (per-block `createGuard({ database })`; umbrella `createVendo({ database })` passes it down).

```ts
// The full registry of slices core defines. NOT all required at once — each block
// requires only its slice subset via Pick (review finding: v2's "all-required
// VendoStorage" couldn't typecheck the partial examples).
interface StorageRegistry {
  threads:  ThreadStorage;      // conversation persistence — records are OPAQUE to core
  modules:  ModuleStorage;      // envelope rows + bare git repos
  state:    StateStorage;       // module runtime data (vendo/state backend)
  grants:   GrantStorage;       // permission grants — context-scoped, seal-bound
  secrets:  SecretStorage;      // scoped secret store — provenance-gated access (I4)
  audit:    AuditLogStorage;    // append-only, provenance-carrying (I7)
  runs:     RunHistoryStorage;  // automation firings + outcomes
  memory?:  MemoryStorage;      // reserved & OPTIONAL — memory track defines operations
  meter?:   MeterStorage;       // reserved & OPTIONAL — meter track defines operations
}

// Each block states its need as a Pick, so partial implementations typecheck:
type GuardStorage       = Pick<StorageRegistry, "grants" | "audit">;
type AutomationsStorage = Pick<StorageRegistry, "modules" | "runs" | "audit">;
// createGuard({ database }: { database: GuardStorage }) — needs exactly these two.
```

Rules: every operation principal-scoped; stores assign ids/timestamps (callers never author identity); a block requires only its `Pick` subset, so `createGuard({ database: { grants, audit } })` typechecks and a full `createStorage()` object satisfies it too. **No `database` configured → in-memory defaults** — with a stated caveat: on a serverless/stateless host, in-memory means grants and modules are dropped every cold start (perpetual re-prompting), so any real deployment configures a `database`. **Anonymous enforcement is structural** (review finding): core ships `withAnonymousGuard(storage)` — applied by every block's `create*` — routing anonymous-principal operations to an ephemeral session-scoped layer (TTL per §4) regardless of the underlying implementation. `threads` stores opaque message records (review ruling): core defines the record envelope (ids, ordering, principal scoping) and never types message *content* — the ai-SDK message shape is `@vendoai/agent`'s business. `secrets` enforces I4's provenance gate: `putForUser`/`putForHost` on write, `reference(handle)` for module code, and value injection only at the egress proxy for handle-mode.

## 11. Theme

`ThemeTokens` (the `.vendo/theme.json` shape): palette, typography, radii, spacing, dark variants. One mapping onto the MCP Apps ~80-CSS-variable vocabulary serves both worlds: inside our surfaces, tokens resolve as live CSS custom-property *references* where the host has them (zero drift on redesign) and values elsewhere; in external hosts (ChatGPT/Claude), modules take the host's theme context and just work. Theme is presentation-only: nothing in policy, storage, or runtime branches on it.

## 12. `.vendo/` directory

```
.vendo/
  theme.json              # extracted brand tokens — dev-editable
  tools.json              # machine facts (paths, schemas) — REGENERATED by `vendo sync`
  tools.overrides.json    # dev-authored edits (descriptions, risk corrections) — merged on top, never touched by sync
  components/             # host components exposed to generated UI — dev-authored
  modules/                # dev-SHIPPED modules: one ordinary folder each (+ optional vendo.json)
  generated/              # machine-owned: env manifest, remix captures, caches — no stability promise
```

Principles: **derive, don't duplicate** — `vendo sync` regenerates, `vendo sync --check` fails CI on drift, sync flags dead overrides; top level dev-owned, `generated/` tool-owned; everything committed (prod builds never require re-extraction); user/agent modules never live here. The machine-facts/overrides split is what makes regeneration always safe.

## 13. Eviction map

| Today in core | Goes to |
|---|---|
| consent card wire schemas, fade proposals, judge strings | `@vendoai/guard` |
| Scheduler seam, Channels seam | `@vendoai/automations` |
| prompt-assembly layer + the LLM loop (today's vendo-runtime engine + vendo-server) | **`@vendoai/agent`** (its own block — decision 2026-07-10) |
| component registry, genui resolve/format | `@vendoai/apps` |
| `CredentialBroker` seam | split: `authenticate` → `@vendoai/agent` (session init); automation grant exchange → invariant I3's per-run credentials in `/runtime`; secret storage → the `secrets` slice (§10) |
| `ai` re-exports (`tool`, `Tool`, `ToolSet`) + `@ai-sdk/provider` dep | deleted → neutral shapes + `/adapters` |
| `SavedVendo`, `RemixRecord`, `AutomationRecord`, monolithic `Store` | module envelope + repo + storage slices |
| `vendo-stage`, `vendo-sandbox-shims` (packages) | folded into `@vendoai/core/runtime` |

Promotion rule for the future: when a second block needs a shape (e.g. memory's proactive proposals want Channels), promote it to core *then* — additive, cheap.

## 14. Migration (big-bang 0.3.0)

Core first (contracts + runtime), then blocks in parallel (each depends only on new core), demos/corpus last as integration proof. The corpus e2e suite (10/10 repos Layer 2, 5/5 Layer 3) is the regression bar the finished wave must re-clear. No deprecation period; delete on replace.

## 15. Usage sketches (contract validation)

Each core contract, consumed by the block code a dev would actually write — ugliness here fails the contract:

```ts
// ── ONE-TIME setup (module scope): construct blocks once, reuse across requests ──
const guard = createGuard({ database });                       // process-scoped: pools connections
const actions = createActions(manifest);                       // UnboundVendoTool[]

// ── PER-REQUEST: bind identity, then hand framework-shaped tools to the loop ─────
// app/api/chat/route.ts
const principal = await identify(req);
const safe = guard.wrap([...fromAiSdkTools(theirTools), ...actions]);   // still unbound
const tools = toToolSet(safe, { principal, provenance: { kind: "chat" } });  // → BoundToolSet
return streamText({ model, tools, messages }).toUIMessageStreamResponse();
// guard's "ask" rides the SDK's native tool-approval channel (§3.2) — stock useChat works.

// ── apps: the entire render path ────────────────────────────────────────
const view = await runtime.render(ref, { tools: safe, principal, theme, anchorData });
container.append(view.element);

// ── automations: the entire fire path ───────────────────────────────────
const result = await runtime.execute(ref, { tools: safe, principal });
await storage.runs.record(principal, ref.id, result);

// ── meter: counts calls without knowing any framework ───────────────────
await storage.meter.increment(ctx.principal, ctx.provenance.kind, cost(ctx));

// ── a Python module calling tools (server sandbox, MCP endpoint, I2/I3) ─
// import vendo; vendo.tools.call("list_invoices", {"overdue_days": 15})

// ── custom persistence: implement only the slices your block needs (§10 Pick) ──
const guard2 = createGuard({ database: { grants: myRedisGrants, audit: myAudit } });
```

**Named types used above** (one-line glosses so §8/§15 are self-contained): `ModuleRef` = `{ id; seal }` handle to a stored module; `ModuleView` = `{ element; dispose() }` the mounted iframe/view; `RunResult` = `{ status; outcome?; error? }` from a headless run; `ModuleWorkspace` = the agent's live sandbox dir with `writeFile`/`save()`; `ToolBinding` = the discriminated `http | …` execution binding.

## 16. Open questions → owned by other tracks

- **apps**: `view.json` tree schema (streaming-first key order; today's UINode evolves there); anchor→module pin mapping; workspace UX; component descriptor conventions
- **agent**: the LLM loop, prompt assembly, ai-SDK message protocol, provider seam (incl. speed levers: prompt caching, small-model fast lane, judge parallelization)
- **automations**: trigger vocabulary (cron/webhook/event) in the envelope; run-history semantics; parked-action delivery UX
- **guard**: policy pipeline, consent ceremony, fade, judge; finer policy dimensions (data sensitivity, unattended eligibility); writes-after-broad-reads scrutiny (I5)
- **actions**: extraction (OpenAPI/route-scan → tools.json), binding execution
- **mcp**: serving modules outward as MCP Apps; host-side OAuth door
- **runtime**: SandboxProvider pick (E2B vs self-hosted microVM — maturity check); Nixpacks vs CNB; isolate middle tier (speed doc); persistent-stage hot swap (F3a-gated)
- **store**: Drizzle/PGlite implementation of the slices incl. `withAnonymousGuard`
- **cli/umbrella**: entry-point story (`vendo init` → ???), `createVendo` sugar, sync/drift tooling, deterministic sync commits
- **cloud**: shared-module registry, signing infrastructure, revocation/advisories (shapes are core's, §5.3)
- **speed**: `research-2026-07-module-speed.md` + `research-2026-07-apps-speed-capability.md` recommendations, mapped per track above
