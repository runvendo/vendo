# Flowlet F3a — Sandbox runtime + bridge (Design)

- **Issue:** ENG-177 (F3a · Sandbox runtime + bridge)
- **Date:** 2026-06-30
- **Status:** Design approved; spike-first. Builds on F1 (`docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`).
- **Blocked by:** F1 (done, on `main`). **Sibling of:** F2 (ENG-176, not started). **Unblocks:** F3b (ENG-180, renderer + format).
- **Scope note:** ENG-177 was repurposed from the original "Gen-UI engine" into F3a during the F1 critique. The renderer + declarative format is the separate ticket **F3b (ENG-180)**. This doc is F3a only.

## 0. What F3a is, and is not

F3a builds **Layer 4's substrate**: the secure stage that agent-generated UI renders inside, and the bridge that carries theme, state, and actions across the sandbox boundary. It is the *stage*; F3b is what *draws on* the stage.

- **In scope:** the one-stage-per-surface sandbox iframe; theme injection; the app-state proxy; the action-chokepoint **transport** (postMessage JSON-RPC, validated against MCP Apps / mcp-ui); host-component **provisioning** (pre-built bundle loaded into the stage); the **renderer↔stage interface** that F3b builds against.
- **Out of scope (F3b):** the concrete generated-UI format (A2UI / Crayon / Thesys C1 / OpenUI), the node→DOM rendering algorithm, loading/streaming visual states. F3a stubs the renderer at the seam.
- **Out of scope (F2):** the real LLM engine, Composio, approval *policy*. F3a builds against F1's stub agent and F1's frozen action-chokepoint *shape*; `principal` / `capability` stay opaque.

F3a is decoupled from F2 by design: it builds against F1's stub agent stream and the frozen `DispatchAction` semantic shape, so F2 switching runtime (e.g. to Mastra, which emits `ai`-SDK-compatible streams) does not touch F3a.

## 1. Locked decisions (inherited + new)

Inherited from F1: all agent UI sandboxed (#4); one stage per surface (#5); composition tree, source per node (#6); reuse the sandbox standard as the bridge *primitive*, not the rendering model (#7); generated lane stays format-agnostic until F3b (#8); host-component provisioning opens with a spike (#9).

New to F3a:

1. **Spike-first.** F3a opens with a throwaway spike that proves the one-stage provisioning model and produces the renderer↔stage interface, before any productized build. §2.
2. **Bridge wire format = MCP Apps / mcp-ui postMessage JSON-RPC.** Adopt the bridge primitive; the spike chooses between the official `@modelcontextprotocol/ext-apps` host primitives and a thin layer that conforms to the same wire format. No bespoke wire format. §4.
3. **Host code enters the stage via a pre-built bundle.** The host ships a Flowlet build artifact exposing its registered components by name; the stage `import()`s it once per surface. §6.
4. **App-state is a read-only proxy.** State is pushed in as snapshots; every mutation leaves as an action through the chokepoint. One path to side effects. §5.
5. **New package `@flowlet/stage`** for the framework-agnostic stage host + bridge + sandbox runtime; thin React mount glue stays in `flowlet-react`. §8.

### Research note (updates the F1 doc's assumption)

The F1 doc treated MCP Apps as "spec finalizing mid-2026, behind F3." As of this design it is firmer: **MCP Apps (SEP-1865) is the ratified extension**, final spec lands **2026-07-28**, reference impl `@modelcontextprotocol/ext-apps` is published, and major hosts (Claude web/desktop, VS Code Copilot, Goose, Postman) already render it. Its model — server ships a sandboxed-iframe UI; **all view→host traffic is auditable MCP JSON-RPC over postMessage**; UI-initiated tool calls need consent — maps cleanly onto Flowlet's action chokepoint. We adopt its *bridge*, not its *server-ships-template rendering model*.

## 2. The spike (the gate)

The spike is a throwaway prototype whose only job is to de-risk the productized build and freeze the inner seam. It is not shipped.

**Pass criteria, in risk order:**

1. A pre-built host-component bundle loads and runs inside *one* sandboxed iframe.
2. Theme tokens injected → the host component renders brand-aligned.
3. An app-state snapshot is proxied in and readable by the component.
4. A button action **round-trips** out through the chokepoint (postMessage JSON-RPC) and a result returns.
5. The iframe **auto-sizes** to its content.
6. A **mixed tree** (prewired primitive + host component + a placeholder generated node) coexists in the one stage.

**Deliverables:** the prototype (kept in a `spike/` dir or branch, not in the shipped packages), a short findings note appended to this doc, and the **frozen renderer↔stage interface** (§7). If any criterion fails, redesign before committing — that is the point of the spike.

## 3. Architecture — the one Stage

A **Stage** is a single sandboxed iframe per agent surface. The whole composition tree renders inside it; the iframe cost is paid once per surface (decision #5).

- **Sandbox:** `sandbox="allow-scripts"`, **no** `allow-same-origin` → opaque origin, no access to host DOM, cookies, or storage. Loaded via `srcdoc` carrying a tiny bootstrap (bridge handshake + a mount root).
- **Stage runtime (inside the sandbox):** receives a `UINode` tree + theme + state over the bridge; resolves `component` nodes against the loaded host bundle and prewired primitives; mounts them; routes `generated` nodes to the renderer seam (F3b; stubbed here). Owns auto-sizing (reports content height out).
- **Stage host (outside, in the host page):** creates the iframe, performs the bridge handshake, injects theme, pushes state snapshots, terminates the action chokepoint, and forwards the agent's `data-ui` nodes inward.

The Stage host is framework-agnostic. A thin React adapter in `flowlet-react` wires it to `FlowletProvider` and replaces F1's non-production `StubRenderer` with the real-boundary mount.

## 4. The bridge (transport)

The bridge is F3a's core deliverable: the correlated, auditable channel across the sandbox boundary, on the **MCP Apps / mcp-ui postMessage JSON-RPC** wire format.

- **host → sandbox:** an initialize message (theme + initial state + node tree) and update messages (replace a node by `id`, theme change, state change). Aligns with MCP Apps' `ui/initialize` family.
- **sandbox → host:** action messages (MCP Apps `tools/call` dialect) → mapped onto F1's frozen `DispatchAction` / `ActionRequest` / `ActionResult`. F1 froze the *semantic shape*; **F3a supplies the transport that carries it.** The host returns `{ result }` or `{ error }`, correlated by request id.

**Library choice is a spike output.** Evaluate `@modelcontextprotocol/ext-apps` host primitives first (official, reused). If its server-ships-template assumptions fight Flowlet's host-driven stage, fall back to a thin postMessage JSON-RPC layer that **conforms to the same wire format**. Either way: reuse the standard, never invent a wire format.

## 5. Theme injection + app-state proxy

- **Theme:** the host serializes brand tokens to CSS custom properties, injected as `:root { --… }` at init and re-sent on change. Host components *and* generated UI read the same variables → one consistent brand across all three node sources.
- **App-state:** a **read-only snapshot** pushed at init and on change. The sandbox never mutates host state directly; writes leave as **actions** through the chokepoint (consent + audit). This keeps the action chokepoint the single path to side effects (F1 §8).

Both theme and state cross the bridge as **data only** — there is no code-injection path through them.

## 6. Host-component provisioning (productized from the spike)

The contract the spike proves and §1.3 commits to:

- The host registers F1 `RegisteredComponent` descriptors (the LLM-facing menu) **and** ships a **pre-built bundle** (a Flowlet build step) exposing those component impls by name as an ESM artifact.
- The Stage runtime loads the bundle **once per surface** and resolves `source: "host"` component nodes against it. Prewired primitives live in Flowlet's own stage bundle. `generated` nodes go to the renderer seam (F3b).
- Decision #9's checklist, handled pragmatically: bundle loading (the artifact); CSS / fonts / tokens (theme injection, §5); context / state snapshots (state proxy, §5); sizing (auto-size, §3); focus / a11y (basic support + documented limits); **versioning** (the bundle carries a version; a mismatch with the registry surfaces a typed `version` error, §9).

The exact build-step shape (CLI vs Vite plugin, shared-dep/React-singleton handling, dev/HMR story) is refined by the spike's findings before the productized contract is frozen.

## 7. The renderer↔stage interface (the inner seam)

F3a's most important *output*: the contract that lets F3b build in parallel against a stub stage (the same trick F1 used one layer up with the stub agent).

Illustrative shape (frozen by the spike, not final code):

```ts
// F3a provides the stage; F3b implements the node walk against this.
interface StageMount {
  resolveComponent(name: string, source: "prewired" | "host"): ComponentImpl | undefined;
  theme: ThemeTokens;                 // CSS-var-backed brand tokens
  state: Readonly<AppStateSnapshot>;  // read-only proxy
  dispatch(action: ActionRequest): Promise<ActionResult>;  // F1's frozen shape
}
type RenderTree = (root: Element, node: UINode, mount: StageMount) => void;
```

F3a ships a **stub `RenderTree`** honoring this seam — the real-boundary replacement for F1's `StubRenderer`. F3b later swaps in the real format-driven walk.

## 8. Package layout

- **New `@flowlet/stage`** — framework-agnostic. Stage host (iframe lifecycle, bridge handshake, theme/state push, action-chokepoint termination), the sandbox-side stage runtime + bootstrap, the bridge transport, the stub renderer at the §7 seam. Depends on `@flowlet/core`. Zero React.
- **`flowlet-react`** — gains a thin Stage adapter that mounts `@flowlet/stage` and replaces `StubRenderer`. Existing provider/registry/hook unchanged.
- **`@flowlet/core`** — unchanged (its `DispatchAction` shape is the bridge's target).

## 9. Errors, security, testing

- **Errors:** typed error parts — `sandbox` (iframe failed to init), `bridge` (malformed / uncorrelated message), `provision` (bundle load / resolve failure), `version` (bundle ↔ registry mismatch). Taxonomy borrows from mcp-ui where it exists (F1 §8).
- **Security:** opaque-origin iframe, no `allow-same-origin`; every action audited through the chokepoint; theme + state are data-only over the bridge; bundle code runs only inside the sandbox, never the host tree (decision #4).
- **Testing:** jsdom cannot run real cross-origin iframes, so —
  - **Unit:** the bridge protocol (encode / decode, request↔response correlation, the action round-trip) against a mock postMessage pair.
  - **Integration:** the stage in a real browser via **Playwright** during the spike (load bundle, inject theme, proxy state, round-trip an action, auto-size, mixed tree).
  - **Contract:** against F1 seams — `UINode` resolution, `DispatchAction` shape conformance, the §7 inner seam.

## 10. Risks (honest)

1. **Host bundling is real host-dev burden.** A build step + React-singleton / shared-dep handling is the cost of the pre-built-bundle model. The spike must surface how painful it is before the contract is frozen; if it is too painful, runtime delivery (option B) is the documented fallback.
2. **MCP Apps fit is unproven for a host-driven stage.** The standard assumes a server ships the template; Flowlet drives the stage from the agent stream. The spike validates whether `ext-apps` host primitives fit or we conform with a thin layer.
3. **a11y / focus across the sandbox boundary.** Focus management, keyboard, and screen-reader behavior through an iframe are genuinely hard; F3a targets basic support + documented limits, not a full solution.
4. **Auto-sizing edge cases.** Content-height reporting across the boundary has known failure modes (async content, transitions); handled but called out.

## 11. Open questions (resolved by the spike or deferred)

- Exact host build-step shape (CLI vs Vite plugin; React-singleton strategy; dev/HMR) — spike output, §6.
- Bridge library commitment (`ext-apps` vs thin conforming layer) — spike output, §4.
- Whether prewired primitives ship in the stage bundle or a separate provisioned bundle — spike output, §6.
- Streaming/partial-node updates — deferred to F3b (F1 deferred incremental partial-prop streaming there).
