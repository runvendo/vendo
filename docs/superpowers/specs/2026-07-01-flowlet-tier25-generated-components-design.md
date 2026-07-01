# Flowlet Tier 2.5 — AI-generated components in the tight sandbox (Design)

- **Date:** 2026-07-01
- **Status:** Design approved in brainstorming (Q1–Q5 locked with user); pending codex + user spec review.
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

Reused as-is: `generated` node kind, `GeneratedPayload` validation/resolution, `ui-delta` streaming, blob-import bundle loading, the action bridge, per-node error boundaries, theming. New: the `components` field, the third resolution step, the `render_view` tool, the policy wiring.

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

- A `GenNode` references a generated component with `source: "generated"` (new member of the source union) and `component: <name in the map>`.
- **Validation (extends `validateGeneratedPayload`):**
  - names must match `^[A-Z][A-Za-z0-9]*$` and must not collide with prewired primitive names (host-catalog collisions are impossible: `source` disambiguates);
  - caps: ≤ 16 components per payload, ≤ 64 KB source per component, ≤ 256 KB total (provision error beyond, consistent with existing DoS caps);
  - a node with `source: "generated"` whose name is missing from the map is a provision error (same contract as a dangling child id).
- **No JSX.** Sandbox has no transform and CSP forbids eval-based compilation. Generated source is plain-JS ESM using `React.createElement` (the runtime already exposes the React instance). The `render_view` tool description instructs the model accordingly; a `h`-style alias is allowed inside the generated module if the model wants one.

## 5. Sandbox runtime changes (`@flowlet/stage`)

- **Init payload** gains `generatedComponents?: Record<string, string>` alongside `bundleSource`/`tree`.
- **Loading:** for each entry, the runtime wraps the source as an ESM blob module and `import()`s it — the exact mechanism `loadBundle` already uses, and the reason the CSP (`'strict-dynamic' blob:`) needs **no changes**. The module's default export must be a function (component); anything else is a per-component provision error.
- **Module interface:** the generated module gets, via injected bindings (not ambient discovery):
  - `React` — the sandbox's React instance;
  - `flowlet.dispatch(action) → Promise<result>` — the existing governed bridge, including approval-pending semantics;
  - its own props (data-bound via `$path` before mount, like every other node) and `children` (which may be catalog components — this is the meshing).
- **Resolution order** in `buildElement`: prewired `PRIMITIVES` table → host bundle (`host[name]`) → **generated map**. `source: "generated"` skips straight to the map. The `[generated]` placeholder branch in the runtime is replaced by real resolution.
- **Failure containment:** a component whose module fails to load/evaluate renders the existing contained error placeholder at each node that references it; the rest of the tree renders. Same per-node error boundary catches render-time throws.
- **Re-render/delta:** unchanged for data (`ui-delta` prop patches). A change to the `components` map is a structural change → full re-init (the stage-adapter's structure key now includes the components map).

## 6. Agent tool (`@flowlet/agent`)

New `createRenderViewTool(writer)` next to the existing `createRenderTool`:

- **Input schema (zod):** the full `GeneratedPayload` shape (formatVersion, root, nodes, data?, components?).
- **Execute:** run `validateGeneratedPayload` server-side first; on failure return the typed error message to the model (so it can self-correct in-turn) instead of streaming a broken node; on success write `{ type: "data-ui", data: { kind: "generated", id, payload } }`.
- **System-prompt contract** (demo-bank `agent.ts`): teach the model when to use `render_ui` (one simple component) vs `render_view` (a composed view, novel UI, or anything needing layout/data-binding); document the no-JSX/`React.createElement` requirement, the `flowlet.dispatch` API, `$path` bindings, and the caps.

## 7. Real action policy (replaces demo allow-all)

The policy layer already exists in `@flowlet/agent` (annotation rules, principal rules, natural-language rules, composition). What's missing is using it. This effort:

- **Replaces `allowAllPolicy` in demo-bank** with a composed policy:
  - read-only / annotated-safe tools (`getTransactions`, catalog renders) → `allow`;
  - external side-effect tools (Slack post, Gmail send, anything Composio-write) → `approval` — surfaced through the existing `ApprovalCard` / approval-pending dispatch flow (already built in shell + runtime);
  - natural-language remember-rules keep working on top (Beat 3 unchanged: its Slack post is authorized by the user's standing rule).
- **Sandbox dispatches flow through the same policy** — a generated component's `flowlet.dispatch` is not a second door; it lands in the same host-side evaluate step as agent tool calls.
- Non-goal: new policy *features*. This is wiring existing machinery so the Q3 trust model's precondition ("policy must not be allow-all") is true.

## 8. Host wiring (`@flowlet/react` + demo-bank)

- `stage-adapter` passes `payload.components` through `createGenUISession`/`initialize` to the stage; structure key extended so a components change re-inits.
- demo-bank's `render-node.tsx` needs **no new branch**: `kind: "generated"` already routes to `FlowletStage`. The `App`/`HtmlApp` branch stays as-is (follow-up work).

## 9. Security posture (what keeps this safe)

1. **No egress:** generated code runs under the F3a CSP (`script-src` nonce/strict-dynamic/blob only, no network directives) in an opaque-origin iframe. `fetch`/XHR/WebSocket/image-beacons are blocked by CSP + no `allow-same-origin`. Nothing here loosens the CSP.
2. **Governed actions only:** the only host-reaching capability handed to generated code is `flowlet.dispatch`, which resolves on the host through the real policy (§7) with approval UI for powerful actions.
3. **Scoped state:** generated code sees only the state slice the host projects (existing F3a contract) and the payload's own `data`.
4. **Resource caps:** component count/size caps (§4) + existing node/depth/op caps bound hostile payloads.
5. **Residual risks accepted:** in-sandbox CPU burn (mitigatable later with a watchdog; out of scope), and anything the *policy* allows — the policy is the fence, which is why §7 is in scope.

## 10. Testing

- **`@flowlet/core`:** validator accepts/rejects the new field (caps, name rules, dangling generated refs); resolver passes `source: "generated"` nodes through.
- **`@flowlet/stage` (unit):** init-payload plumbing; resolution order (primitive shadowing, host vs generated); module-shape errors contained per-node.
- **`@flowlet/stage` (browser suite):** a generated component actually evaluates, mounts, receives props/children, dispatches an action round-trip; a `fetch()` from generated code is **blocked** (egress gate, same harness as the F3a spike gates); a throwing generated component leaves siblings rendered.
- **`@flowlet/agent`:** `render_view` validates before streaming; invalid payload returns model-visible error; policy composition — read tool allows, Slack-write requires approval, remember-rule authorizes Beat 3.
- **demo-bank (manual/visual):** per the visual-verification rule, render a meshed view (novel component + catalog Chart side by side) and screenshot; exercise one approval flow end-to-end.

## 11. Follow-ups (documented, not built here)

1. **Retire or jail `HtmlApp` (Tier 2):** migrate full-document generated apps into the tight sandbox or give the loose iframe a real CSP; until then the dino-game path can still phone home.
2. **CPU/robustness watchdog** for runaway generated code.
3. **JSX authoring convenience** (host-side transpile step) if `React.createElement` output proves error-prone for the model.
