# Flowlet F3a — Sandbox runtime + bridge (Design)

- **Issue:** ENG-177 (F3a · Sandbox runtime + bridge)
- **Date:** 2026-06-30
- **Status:** Design approved after a two-reviewer adversarial pass (see §0). Spike-first. Builds on F1 (`docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`).
- **Blocked by:** F1 (done, on `main`). **Sibling of:** F2 (ENG-176, not started). **Unblocks:** F3b (ENG-180, renderer + format).
- **Scope note:** ENG-177 was repurposed from the original "Gen-UI engine" into F3a during the F1 critique. The renderer + declarative format is the separate ticket **F3b (ENG-180)**. This doc is F3a only.

## 0. Revision history

- **v1 (initial):** spike-first one-stage design; pre-built host bundle; MCP Apps/mcp-ui bridge; theme + state proxy; renderer↔stage seam.
- **v2 (this doc) — after a two independent-reviewer adversarial pass.** Convergent findings forced material changes, all folded in below:
  - **The sandbox does NOT jail network egress.** `sandbox="allow-scripts"` leaves `fetch`/`WebSocket`/`Image().src`/`sendBeacon` open → proxied state is exfiltratable. Fixed by an in-`srcdoc` **egress CSP** (§9), which also forces **bundle-as-data** loading (§6) and corrects the old "no code over the bridge" framing.
  - **Most real host components can't run sandboxed** (the React context wall). v1 is **presentational-only, framed as the principled security boundary**, not a temporary limit (§6).
  - **The §7 seam was too thin to freeze.** Shrunk to what F3a genuinely owns; render/lifecycle/error-isolation handed to F3b (§7).
  - **a11y across the boundary is load-bearing** (banking) → a scoped **internal-accessibility go/no-go** in the spike (§2, §10).
  - **MCP Apps gives conventions, not interop** (Flowlet inverts its model) → conform to the wire-format conventions, no `ext-apps` dependency, drop the interop claim (§4).
  - Mechanical fixes: callbacks-as-action-descriptors (§4), approval-pending dispatch (§4), capability transport security (§4), scoped state projection (§5), theme/font limits (§5), real-browser tests in shipped CI (§9), spike criteria re-aimed at the hard gates first (§2).

## 1. What F3a is, and is not

F3a builds **Layer 4's substrate**: the secure stage that agent-generated UI renders inside, and the bridge that carries theme, state, and actions across the sandbox boundary. It is the *stage*; F3b is what *draws on* the stage.

- **In scope:** the one-stage-per-surface sandbox iframe; the egress-jailed security model; theme injection; the scoped app-state proxy; the action-chokepoint **transport** (postMessage JSON-RPC, MCP-Apps-shaped conventions); host-component **provisioning** (pre-built, presentational-only bundle loaded as data); the **stage-capability interface** F3b builds against.
- **Out of scope (F3b):** the concrete generated-UI format (A2UI / Crayon / Thesys C1 / OpenUI), the node→DOM rendering walk, node lifecycle/reconciliation, per-node error boundaries, loading/streaming visual states. F3a provides the stage; F3b mounts inside it.
- **Out of scope (F2):** the real LLM engine, Composio, approval *policy*, capability *minting policy*. F3a builds against F1's stub agent and F1's frozen action-chokepoint *shape*; it owns the transport's *security*, not the policy.

F3a is decoupled from F2 by design: it builds against F1's stub agent stream and the frozen `DispatchAction` semantic shape, so F2 switching runtime (e.g. to Mastra, which emits `ai`-SDK-compatible streams) does not touch F3a.

## 2. The spike (the gate)

The spike is a throwaway prototype (lives in `spike/`, never shipped) whose only job is to de-risk the build and freeze the stage-capability interface. **Pass criteria are ordered hardest/most-uncertain first** (the v1 ordering tested the easy risks first and hid the real ones):

1. **Bundle loads under a realistic host CSP, as data, with egress jailed.** A pre-built host bundle, injected as data (`blob:`/srcdoc text — not a network fetch), `import()`s and runs inside one `sandbox="allow-scripts"` srcdoc iframe whose injected CSP sets `connect-src 'none'` (and locked `img-src`/`script-src`). Prove load works *and* that `fetch`/`Image` egress is blocked. **This is the gate** — it fails on exactly the CSP-hardened hosts the product targets if it fails at all.
2. **A real presentational host component renders, themed.** Not a toy `<div>`: a design-system-style component (props-driven, uses theme tokens). Document the exact adaptation any *context-dependent* component would need (→ §6 adaptation contract is the spike's headline deliverable).
3. **Scoped state projection is readable.** A whitelisted state slice (not the whole app state) is proxied in and read by the component.
4. **An interactive callback round-trips as an action.** A button inside a provisioned component, expressed as an action descriptor, dispatches through the chokepoint and a result returns — proving the callbacks-as-descriptors model (§4), not just bootstrap chrome.
5. **A deliberately-throwing node is isolated.** One node throws on render; the rest of the stage survives (proves the error-isolation contract the seam must support, even though the boundary impl is F3b).
6. **The iframe auto-sizes** to content (ResizeObserver→postMessage height) without oscillation on async content.
7. **Internal accessibility go/no-go.** Assess whether a self-contained stage can be internally accessible to a basic WCAG bar (focus order, label/control association *within* the document, keyboard, SR announcements). If even the internal case fails, escalate — it challenges F1 decision #4 (sandbox-everything). Cross-boundary a11y coordination is docked as known-hard, not gated here.
8. **A mixed tree** (prewired primitive + presentational host component + placeholder generated node) coexists in the one stage.

**Deliverables:** the prototype, a findings note appended here, the **host-component adaptation contract** (§6), and the **frozen stage-capability interface** (§7). If any gate fails, redesign before committing.

## 3. Architecture — the one Stage

A **Stage** is a single sandboxed iframe per agent surface; the whole composition tree renders inside it (decision #5).

- **Sandbox:** `sandbox="allow-scripts"`, **no** `allow-same-origin` → opaque origin, no access to host DOM, cookies, storage. Loaded via `srcdoc` carrying a bootstrap **plus an injected CSP `<meta>`** that jails network egress (§9). The host bundle is delivered **as data** (§6), not fetched over the network — so a CSP-hardened host page doesn't block it and there is no egress channel.
- **Stage runtime (inside the sandbox):** receives a `UINode` tree + theme + scoped state over the bridge; resolves `component` nodes against the loaded presentational bundle and prewired primitives; hands `generated` nodes to the renderer mounted by F3b. Reports content height out (auto-size).
- **Stage host (outside, in the host page):** **vanilla TS, genuinely framework-agnostic** (it only creates an iframe and exchanges postMessage) — creates the iframe, performs the bridge handshake, injects theme + bundle + scoped state, terminates the action chokepoint, forwards the agent's `data-ui` nodes inward.

A thin React adapter in `flowlet-react` wires the stage host to `FlowletProvider` and replaces F1's non-production `StubRenderer` with the real-boundary mount.

## 4. The bridge (transport)

The bridge is F3a's core deliverable: a correlated, auditable postMessage channel using **MCP-Apps-shaped JSON-RPC conventions** — framing, correlation ids, and the "all sandbox→host side effects go through one auditable method" discipline.

**Honest framing (changed in v2):** this is **convention reuse, not ecosystem interop.** MCP Apps assumes an MCP *server* ships a self-contained template that a host renders; Flowlet inverts this — *our host* pushes a mutable node tree *inward* and updates it node-by-node, a direction MCP Apps does not model. So a Flowlet stage will **not** render inside Claude/VS Code and vice-versa. We adopt the *vocabulary* (familiarity, auditability, a future on-ramp) via a **thin hand-built layer**, with **no dependency on `@modelcontextprotocol/ext-apps`** (its host primitives assume their model). A timeboxed look at `ext-apps` happens in the spike, but the layer is expected to be ours.

- **host → sandbox:** `ui/initialize` (theme + bundle ref + scoped state + node tree) and `ui/update` (replace a node by `id`, theme change, state change). MCP Apps has no equivalent host-push methods — these are **our application-layer extension**, named in its style.
- **sandbox → host (the chokepoint):** action messages mapped onto F1's `ActionRequest` / `ActionResult`. F1's `ActionRequest` carries `originNodeId` (provenance) and `capability` (authorization), which **do not fit standard `tools/call` params** — so this is an **explicit extension**, owned and documented, not a claim of pure conformance.
  - **Callbacks as action descriptors.** Component `props` are declarative data (functions don't survive postMessage). Interactivity is expressed as **action descriptors** in props; the stage rewrites a triggered descriptor into a chokepoint dispatch. This mapping is part of the provisioning contract.
  - **Approval-suspended dispatch.** A gated action may suspend for human consent for minutes, across a refresh — so dispatch must **not** rely on a held-open postMessage promise (F1 §5.5 rejected imperative held approvals for this reason). Dispatch resolves **`pending`** immediately; the gated outcome reconciles later through the **agent stream** (F1's native channel), not the bridge promise.
  - **Capability transport security (F3a owns; policy is F2).** The token is **minted host-side**, **opaque and unforgeable to the sandbox**, **bound to `originNodeId`**, and **expirable**; the host validates it on every action. A token the sandbox can read and replay is not a control — so it is a host-validated handle, not secret data handed to untrusted code.
  - **Error / timeout / abort.** JSON-RPC errors map to F1's `{ error: { code, message } }`; every action has a timeout; in-flight actions are abortable (ties to F1's `AbortSignal`).

## 5. Theme injection + scoped state proxy

- **Theme:** the host serializes brand tokens to CSS custom properties, injected as `:root { --… }` at init and re-sent on change. **Limit (stated honestly):** this only styles **CSS-var-authored** components. JS-theme systems (MUI `useTheme()`, styled-components/emotion theme objects, Tailwind utility classes) won't read `:root` vars unless their stylesheet also ships into the stage — part of the presentational adaptation contract (§6). **Fonts** are network resources; under the egress CSP they must be **injected as data** (base64/`blob:`), not fetched cross-origin.
- **App-state:** a **scoped, whitelisted, read-only projection** the host opts into **per surface** — never the whole app state (which would be an exfiltration surface and a perf/serialization problem). Pushed at init and on change. **Serialization contract:** structured-clone-safe values only; functions, class instances, and live framework objects are excluded by the projection. The sandbox never mutates host state directly; writes leave as **actions** through the chokepoint. One path to side effects (F1 §8).

Theme and state cross the bridge as **data only**. (Bundle code crosses host→sandbox as data too, but runs only inside the jailed sandbox; the **sandbox→host** direction stays strictly data-only — that is the invariant.)

## 6. Host-component provisioning — presentational-only (the principled boundary)

**The context wall, and why presentational-only is correct, not a compromise.** Host components run in the sandbox's separate JS realm, so React Context does not cross: `useRouter`, `useQuery`, theme/store providers yield nothing. A **presentational** component (props → JSX, local state) works; a **connected** component (fetches/navigates/mutates internally) does not. Crucially, a connected component would also **bypass the action chokepoint** — doing I/O and mutations outside the audited path. So provisioning connected components isn't just hard, it is **unsafe by our own model**. v1 therefore provisions **presentational components only**, and this is the *right* boundary: the agent composes brand-defining presentational components and routes all data *in* (scoped state) and all actions *out* (chokepoint).

**The adaptation contract (the spike's headline output):** a provisionable component is a pure function of **(props, theme tokens, scoped state)**; it **does not fetch, route, or mutate** — those cross the bridge; interactivity is expressed via **action descriptors** (§4). "Adapting" a connected component means lifting its data/actions out to props — i.e. making it presentational. Providing the host's providers *into* the stage is an explicit **future escape hatch**, not v1.

**Mechanics:**
- The host registers F1 `RegisteredComponent` descriptors (the LLM-facing menu) **and** ships a **pre-built ESM bundle** (a Flowlet build step) of those presentational impls, **delivered as data** into the stage (§3/§9).
- **React singleton:** the risk is the *stage runtime's* React vs the *host bundle's* React **inside the same iframe realm** (not host-page-vs-sandbox). The build must **externalize React** so one copy loads in the stage. (Spike confirms the exact build mechanism.)
- The Stage runtime loads the bundle **once per surface**, resolves `source: "host"` nodes against it; prewired primitives live in Flowlet's own stage bundle; `generated` nodes go to F3b.
- **Versioning:** the bundle carries a version; a mismatch with the registry surfaces a typed `version` error (§9).
- Build-step shape (CLI vs Vite plugin; externalization; dev/HMR) is refined by spike findings before the contract is frozen.

## 7. The stage-capability interface (the inner seam — shrunk to what F3a owns)

F3a's key *output* for parallel F3b work. v1 tried to freeze a `RenderTree` that walks the node tree — but render, lifecycle (mount/update/unmount), reconciliation, and per-node error boundaries are **F3b's** design, deferred in F1, and can't be frozen without F3b's answers. So F3a freezes only the **stage capabilities** F3b consumes; **F3b mounts its renderer inside the stage F3a provides** and owns the rest.

Shape (**validated by the spike** — see §12; `subscribe` stays provisional as the spike did a single render, no streaming updates):

```ts
// F3a provides these capabilities; F3b's renderer consumes them. Names track what the
// spike runtime actually used (resolve via the loaded bundle map, $state-bound props,
// __nodeId provenance, descriptor dispatch).
interface StageCapabilities {
  resolveComponent(name: string, source: "prewired" | "host"): ComponentImpl | undefined; // undefined → F3b renders an error placeholder
  theme: ThemeTokens;                          // CSS-var-backed brand tokens (injected as :root{--…})
  getState(): Readonly<StateProjection>;       // scoped, read-only; bound into props via { $state: "key" }
  subscribe(cb: () => void): () => void;        // PROVISIONAL — not exercised in the spike; F3b's ui/update story
  dispatch(action: ActionRequest): Promise<ActionResult>; // descriptor → tools/call w/ originNodeId+capability; may resolve `pending` (§4)
}
// ComponentImpl = a host/prewired component impl resolved from the loaded bundle (window.__FLOWLET_HOST__
// in the spike); ThemeTokens = CSS-var map; StateProjection = the scoped, structured-clone-safe slice (§5).
```

**Render, node lifecycle, incremental/streaming updates, and per-node error boundaries are explicitly F3b-owned.** F3a ships a minimal stub mount honoring `StageCapabilities` — the real-boundary replacement for F1's `StubRenderer` — sufficient to run the spike's mixed-tree and throwing-node criteria.

## 8. Package layout (carved after the spike passes)

End-state, but **not carved until spike gates 1–4 pass** (carving/publishing a package before the model is validated inverts spike-first; the spike lives in `spike/`):

- **`@flowlet/stage`** — the **stage host is genuinely framework-agnostic vanilla TS** (iframe lifecycle, CSP/bundle/theme/state injection, bridge transport, chokepoint termination). The **inner sandbox runtime** (bootstrap + resolver + stub mount) is a separately-built srcdoc bundle that carries its own externalized React. Depends on `@flowlet/core`.
- **`flowlet-react`** — gains a thin React adapter that mounts `@flowlet/stage` and replaces `StubRenderer`. Existing provider/registry/hook unchanged.
- **`@flowlet/core`** — unchanged (its `ActionRequest`/`DispatchAction` shape is the bridge's target).

## 9. Errors, security, testing

- **Errors:** typed parts — `sandbox` (iframe/CSP init failed), `bridge` (malformed/uncorrelated/timed-out message), `provision` (bundle load/resolve failure), `version` (bundle ↔ registry mismatch). Plus action `error`/`timeout`/`abort` (§4).
- **Security (corrected in v2):** `sandbox="allow-scripts"` controls origin/DOM/cookies/storage/navigation but **does not block network egress** (`fetch`/`WebSocket`/`Image().src`/`sendBeacon`). So the model is **not** airtight by sandbox attributes alone. The boundary is:
  - **Egress jail:** an injected `<meta http-equiv="Content-Security-Policy">` in the srcdoc with `default-src 'none'`, `connect-src 'none'`, `img-src data:`, `script-src 'self' blob:` (or nonce'd) — so proxied state cannot be exfiltrated.
  - **Bundle/theme/fonts as data** (no network), consistent with the egress jail.
  - **Scoped state only** (§5) — minimize what's exposed even inside the jail.
  - Every side effect routes through the host-validated, capability-bound chokepoint; sandbox→host is data-only; bundle code runs only inside the sandbox (decision #4).
- **Testing:** jsdom can't run real cross-origin iframes/CSP, so —
  - **Unit:** the bridge protocol (encode/decode, correlation, action round-trip, pending/abort/timeout) against a mock postMessage pair.
  - **Real-browser (Playwright/WebDriver-BiDi) — in the SHIPPED `@flowlet/stage` CI, not just the spike:** bundle-load-as-data under a CSP, **egress blocked**, action round-trip, auto-size, throwing-node isolation. These are the highest-risk behaviors; they must not regress silently.
  - **Build-artifact test:** the host bundle externalizes React and stamps a version.
  - **Contract:** against F1 seams — `UINode` resolution, `ActionRequest` conformance, the §7 capabilities.

## 10. Risks (honest)

1. **Presentational-only narrows "reuse your components."** Mitigated by framing: connected components are unsafe in our model anyway; the value is in design-system (presentational) components. Risk: a host's library is mostly connected → less reuse than hoped. Spike documents the real ratio.
2. **a11y has a real ceiling.** Internal-accessibility is winnable; cross-boundary coordination with host chrome may not be. Spike's go/no-go (§2.7) surfaces it before F3b/F4 stack on top; a failure escalates against F1 decision #4.
3. **Egress CSP vs functionality.** Locking `connect-src 'none'` means provisioned components genuinely cannot do their own I/O (by design) and all assets must be data-injected. Edge cases (e.g. a component that lazy-loads an image URL) need the action/asset path, not direct fetch.
4. **Host bundling burden.** Build step + React externalization is real host-dev cost; spike measures it before freezing the contract.
5. **Auto-size oscillation** with async content/transitions — known failure mode; tested explicitly.

## 11. Open questions (resolved by the spike or deferred)

- Exact host build-step shape (CLI vs Vite plugin; React externalization; dev/HMR) — spike output, §6.
- Whether prewired primitives ship in the stage bundle or a separate provisioned bundle — spike output, §6.
- Concrete `StageCapabilities` types and whether `subscribe` is granular (per-channel) or coarse — confirmed by F3b's first integration, §7.
- Capability *minting policy* (severity/scope/expiry rules) — F2 owns; F3a only carries + validates the token, §4.
- Streaming/partial-node updates and per-node error-boundary impl — F3b, §7.
- The F1 stub agent only emits one `prewired` node; the spike fabricates a realistic mixed `data-ui` sequence — revalidate against F2's real stream when it lands.

## 12. Spike findings (all 8 gates PASSED — full detail in `spike/FINDINGS.md`)

The throwaway spike (`spike/`, 10 Playwright tests green) validated the model end-to-end. Outcome: **proceed to Phase 2.** Highlights and the decisions they force:

- **Gate results:** load-under-CSP ✓, **egress blocked ✓** (`connect-src 'none'` + `img-src data:`), bundle-as-data ✓, themed render ✓, scoped `$state` ✓, action chokepoint with provenance ✓, per-node error isolation ✓, auto-size ✓, **internal a11y GO** (axe inside the sandbox, zero wcag2a/2aa violations after adding `<html lang>`/`<title>`), mixed tree ✓.
- **a11y GO ⇒ F1 decision #4 holds** at the internal level. Cross-boundary a11y (host chrome ↔ stage) was *not* tested and stays the known-hard case.
- **React into the sandbox (refinement to §6):** the CSP (`script-src 'unsafe-inline' blob:`) **blocks** the import-map/`node_modules` externalization path, so the spike bundles React *into* the host bundle and exposes one `window.__React` (avoids "two Reacts"). **Cost ~200 KB/bundle.** Phase 2 must design a shared-React delivery (a Flowlet React `blob:` ESM both runtime and bundle import) — this is the real meaning of "externalize React."
- **Build-step contract gains a hard requirement:** define `process.env.NODE_ENV` at build time (no `process` in the sandbox) or the bundle throws on load.
- **Bridge confirmed:** `ui/initialize` (host→sandbox) + `tools/call` (sandbox→host chokepoint) over correlated JSON-RPC postMessage; `originNodeId`/`capability` are an explicit extension to `tools/call` (not literal conformance), exactly as §4 predicted.
- **Two things the spike did NOT exercise — Phase 2 design+build items, not validated:** (a) **approval-pending dispatch** (the spike resolves synchronously; the gated `pending` → agent-stream reconcile model from §4 is unbuilt), and (b) **`ui/update` / streaming / replace-node-by-id** (single render only; the `subscribe` capability stays provisional).
- **Weak test to harden in Phase 2 CI:** the auto-size gate passes trivially (browser default iframe height already clears the threshold) — Phase 2 must assert height tracks a content change.
- **Capability is carried but not secured:** the spike passes a `capability` through `tools/call` but does not mint/bind/validate it — the host-side transport-security model (§4) is a Phase-2 build item.
