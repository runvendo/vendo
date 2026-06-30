# F4 · Pre-wired Component Library — Design

**Linear:** ENG-181 · **Depends on:** F1 (ENG-174) · **Feeds:** F3b (rendering), F5 (shell)
**Date:** 2026-06-30

## 1. Goal

Ship the starter **pre-wired component set** the Flowlet agent can render: a curated wrapping of
**Crayon** (`@crayonai/react-ui`, MIT — Radix + shadcn) into the F1 component registry contract,
themeable to the host brand. This is the agent's render *menu* — the named components an agent may
emit as `component` UI nodes.

Out of scope: the sandbox stage, the real renderer, host-component provisioning, the action-chokepoint
transport, and the agent/LLM itself. Those are F3/F5. F4 produces descriptors + React wrappers + a
brand theming contract, verified against F1's stub renderer.

## 2. Build on the F1 contract (do not reinvent)

F1 (`@flowlet/core`) already defines the seam this work plugs into:

- `RegisteredComponent` = `{ name, description, propsSchema (StandardSchema/Zod), source: "prewired" | "host" }`
  — descriptors only (the LLM-facing menu), explicitly **not** the provisioning contract.
- `ComponentNode` = `{ id, kind:"component", source, name, props, children? }` — what the agent emits.
- `flowlet-react`'s `StubRenderer` already accepts an `impls` map (`name → React component`) as a prop
  and renders component nodes directly in the host tree (non-production, no security boundary; the F3
  sandbox stage replaces it later, keeping this seam).

F4 fills both halves of that seam (descriptors + impls) with Crayon-backed components, and adds a brand
theming layer. It does **not** modify `flowlet-core` or `flowlet-react`.

## 3. Isolation: a dedicated package

All F4 work lives in a new package **`@flowlet/components`**.

- Owns the Crayon dependency (`@crayonai/react-ui` only — **not** `@crayonai/react-core`, which is
  Crayon's own chat runtime and would collide with F2/F5).
- Depends on `@flowlet/core` (for the `RegisteredComponent` type) and `zod`; peer-depends on React.
- `flowlet-react` is untouched — consumers pass our exported impls into its existing `StubRenderer`.

Rationale: F2, F3a, and F5 all edit `flowlet-react`. A separate package keeps F4 collision-free.

### 3.1 Two entrypoints (descriptors are React-free)

The descriptor (LLM/menu) path runs server-side (F2) and must **not** pull React or Crayon into that
bundle. So the package exposes two entrypoints over one logical source:

- **`@flowlet/components/descriptors`** — metadata only: `name`, `description`, `propsSchema` (Zod). No
  React, no Crayon imports. This is what builds the registry / LLM menu.
- **`@flowlet/components`** (impls) — imports the descriptors and attaches each React `Component`. Pulls
  in Crayon. This is what the render stage (StubRenderer today, F3 stage later) imports.

The descriptors module is the single source of names + schemas; the impls module references it by import
(see §4), so the two cannot drift even though they ship as separate entrypoints.

## 4. Single source of truth (no drift)

The descriptors module (§3.1) holds one **descriptor entry** per component:

```
{ name, description, propsSchema (Zod) }   // React-free
```

The impls module imports those descriptors and attaches one React `Component` each. From these the
package derives the two F1 artifacts so they can never drift:

- **`prewiredComponents: RegisteredComponent[]`** — the descriptor entries stamped `source: "prewired"`.
  The LLM-facing menu handed to `FlowletProvider`. Importable React-free.
- **`prewiredImpls: Record<string, ComponentType>`** — `name → wrapper`. This is a **module the render
  stage imports**, not data passed over a bridge: the F3 sandbox stage will `import` the impls inside its
  own bundle, while only descriptors, UI nodes, actions, and brand tokens cross the postMessage boundary.

Tests assert: every descriptor has exactly one impl and vice versa; prewired names are globally unique
(see §5.1 on collisions).

## 5. The registered set (~15 components)

All wrappers take props from a **JSON-value boundary** — every prop is a JSON primitive, array, or plain
object; **no React nodes, no functions, no Zod `.transform()`/`.date()`/refinements that yield non-JSON
values**, because props travel agent → renderer as JSON. Icons are referenced by string name and resolved
inside the wrapper; dates are ISO strings. Each wrapper adapts JSON props to Crayon's real prop shapes
(which take React nodes). A test round-trips every schema through `JSON.parse(JSON.stringify(...))` and
confirms JSON-Schema convertibility (§8).

**Each wrapper validates its own props.** The agent (and a buggy/hostile stream) can emit malformed
props, and `StubRenderer` spreads `node.props` into the impl *without* validating. So each wrapper parses
its incoming props against its own `propsSchema` at the top of render and, on failure, renders a small
inline error/fallback instead of throwing or passing garbage into Crayon. Validation lives in the wrapper
(not the renderer) precisely because F4 does not modify `StubRenderer`, and it stays correct when the F3
stage swaps in.

**Content / display:** Card, Table, Chart (`kind`: bar | line | area | pie), Accordion, Carousel,
Callout, Tags, Steps, List, Image, ImageGallery, Markdown, CodeBlock, Tabs.

**Forms:** a single **Form** component whose `fields[]` is a discriminated union over every input type
(text, number, textarea, select, checkbox, radio, switch, toggle, slider, date) plus a submit label.
One clean menu entry covering the whole input surface. In F4 the Form is **inert**: fields render as real
Crayon inputs, but there is **no submit callback in the schema** (that would be a function prop, violating
the JSON boundary) — submit is disabled / no-op. The mechanism for routing a submission to the action
chokepoint is **owned by F3 and not yet defined** — F1's `ComponentNode` has no action field today, so
F4 makes **no claim** about the eventual node/action shape. F4 ships the field rendering, not the side
effect.

**Excluded — chat-shell / runtime chrome (F5's job, not the agent's menu):** OpenUIChat, AgentInterface,
ToolCall, ToolResult, FollowUpBlock/Item, MessageLoading, Skeleton. Registering these would let the agent
render chat-app chrome inside its own output.

**Deferred — interactive / layout primitives:** Modal (a generic overlay, not chat chrome, but carries
focus-trap and sandbox-overlay concerns) and bare layout primitives (Separator, SectionBlock). Not in
v1; revisit with explicit inclusion criteria once the F3 stage's focus/overlay behavior is known.

**Folded into parents (not registered standalone):** CardHeader, ListItem, RadioItem, CheckBoxItem,
SwitchItem, ToggleItem, Tag, Label — child-only primitives that would only add LLM-menu noise.

Each component needs a hand-authored `description` tuned for LLM selection; this is the main per-component
cost, alongside the serializable schema and wrapper.

### 5.1 Composition: leaf / self-contained in F4

F1's `ComponentNode` carries `children?: UINode[]`, but the current `StubRenderer` renders only
`props` and **drops `children`**. F4 does not change that. Therefore every F4 component is **self-contained**:
its content is fully described by its own JSON props (Tabs → `tabs[{label, content}]` where content is
text/markdown; Accordion → `items[{title, content}]`; Card → a `body` string/markdown, not nested nodes).
Rendering arbitrary nested `UINode` children — a recursive tree walk — is a **renderer responsibility owned
by the F3 stage**, not a per-component concern. This keeps F4 honest about what the stub can actually do
and avoids inventing a child-slot contract on a renderer that ignores children.

This does **not** paint F3 into a corner: the leaf schemas are forward-compatible. When F3 wants rich
nested slots (a Card body that is itself a `UINode` subtree), it adds an **optional** slot field and the
recursive rendering — a non-breaking, additive change layered on F1's existing `children?` field. F4's
string/markdown content fields remain valid; they become the simple case alongside the slot case.

### 5.3 Untrusted content: sanitization and resources

The agent-supplied props are **untrusted**, and the F4 stub renders them **directly in the host tree with
no sandbox** (F1: "non-production, no security boundary"). So content components that emit markup or load
resources need an explicit policy, applied inside the wrapper:

- **Markdown:** render through a configuration that **disallows raw HTML** (no `<script>`/`<iframe>`/
  arbitrary tags) — markdown formatting only. Confirm Crayon's `MarkDownRenderer` HTML handling during
  implementation; if it permits raw HTML, sanitize or disable it.
- **Image / ImageGallery / any `src`/`href`:** **allowlist URL protocols** — `https:` and `data:image/*`
  only; reject `javascript:`, `data:text/html`, and other protocols at the schema/wrapper boundary.
- The real isolation boundary is the **F3 sandbox**; these wrapper-level rules are defense-in-depth so the
  unsandboxed stub and the example page are not an XSS vector, and they carry forward into F3.

### 5.2 Name collisions and `source`

F1's registry resolves by `name` alone and ignores `source`, so a prewired name could one day collide with
a host component (F3a). F4's scope-safe guarantees: prewired names are a documented, stable, globally
unique set (PascalCase, no namespace prefix needed for v1), enforced by a uniqueness test. This is
**harmless while only prewired components exist** (F4's world), but it is a real contract gap that **must
be closed before host components ship** (F3a): resolution should be keyed by `(source, name)`. That change
lives in `@flowlet/core`'s registry and `flowlet-react`'s `StubRenderer`, which F4 does **not** own — it
is flagged here as a required follow-up for F1/F3a, tracked there rather than worked around in F4.

## 6. Theming (brand → Crayon)

A small, **serializable, versioned** `BrandTokens` type:

```
{ version: 1, accent, background, surface, text, mutedText, fontFamily, radius, mode? }
```

and a `FlowletThemeProvider brand={...}` that maps tokens → Crayon's `ThemeProvider` theme object + mode.
The host never touches Crayon's theme internals, and plain-object tokens cross the F3 sandbox postMessage
bridge cleanly (per F1 decision #4: theme is proxied into the sandbox). Ships with one default brand for
the example.

**Tokens must be fully resolved primitives** — concrete values, not references into the host environment.
Colors are literal (`#0A7CFF`), not `var(--brand)`; `fontFamily` is a literal font-stack string, not a
handle to a host-loaded font; `radius` is a number/px string. Rationale: the F3 stage runs in an isolated
iframe where host CSS variables and loaded font assets **do not exist**. **Delivering the actual font
files / CSS assets into the stage is an F3 provisioning concern, not F4's** — `BrandTokens` only names
the stack; F3 ensures it's available (or falls back). The `version` field lets the bridge contract evolve
without silent breakage.

## 7. Data flow

Agent emits a `component` UINode (`name` + JSON `props`) → `StubRenderer` resolves the name against the
registry built from `prewiredComponents` → renders `prewiredImpls[name]` inside `FlowletThemeProvider`.
This is the identical seam the F3 sandbox stage will consume.

## 8. Verification

Vitest + `@testing-library/react` + jsdom (mirrors `flowlet-react`'s setup):

- each schema accepts representative valid props and rejects invalid ones;
- **JSON boundary (§5):** every registered schema round-trips through `JSON.parse(JSON.stringify(props))`
  unchanged and converts to JSON Schema — guards against dates/transforms/functions leaking in;
- **descriptor ↔ impl correspondence** is exact (§4): every descriptor has one impl, every impl one
  descriptor;
- **name uniqueness (§5.2):** prewired names are globally unique;
- the `descriptors` entrypoint imports with no React/Crayon in its module graph;
- **invalid-props fallback (§5):** a wrapper given malformed props renders its inline fallback, not a throw;
- **content safety (§5.3):** Markdown drops raw HTML, and a `javascript:`/non-allowlisted image `src` is
  rejected/neutralized;
- every component renders expected themed content under `FlowletThemeProvider`;
- `BrandTokens` (versioned, resolved primitives) map to a valid Crayon theme object.

Plus a new **`examples/components`** page that renders every component themed via `StubRenderer` with
sample props — visible proof without touching the shared `examples/basic` page.

## 9. Build sequencing

Prove the full pattern (manifest → derived artifacts → serializable wrapper → theming → tests → example)
on a representative slice first: **Card** (self-contained content), **Table** (data), **Chart** (viz),
**Form** (inert input union). Once the pattern holds, the remaining wrappers are near-identical and fan
out mechanically.

## 10. Open implementation notes

- Exact Crayon export subpaths and `ThemeProvider` theme-field names are confirmed against the installed
  package during implementation; the wrapper layer insulates consumers from them, and TDD surfaces any
  mismatch immediately.
- `Charts` vs `ChartsV2`: pick the current/stable one during implementation; the `Chart` wrapper's
  `kind`-based public schema is unaffected by the choice.
- **Crayon base CSS:** `@crayonai/react-ui` ships a base stylesheet its components require. The impls
  entrypoint documents/re-exports that CSS import, and the `examples/components` page (and later the F3
  stage bundle) must include it, or components render unstyled. Confirm the exact CSS path on install.
