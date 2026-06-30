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

**Content / display:** Card, Table, Chart (`kind`: bar | line | area | pie), Accordion, Carousel,
Callout, Tags, Steps, List, Image, ImageGallery, Markdown, CodeBlock, Tabs.

**Forms:** a single **Form** component whose `fields[]` is a discriminated union over every input type
(text, number, textarea, select, checkbox, radio, switch, toggle, slider, date) plus a submit label.
One clean menu entry covering the whole input surface. In F4 the Form is **inert**: fields render as real
Crayon inputs, but there is **no submit callback in the schema** (that would be a function prop, violating
the JSON boundary) — submit is disabled / no-op. Submission routes through the F3 action chokepoint via a
declarative action descriptor on the node, defined and wired when that transport exists. F4 ships the
field rendering, not the side effect.

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

### 5.2 Name collisions and `source`

F1's registry resolves by `name` alone and ignores `source`, so a prewired name could one day collide with
a host component (F3a). F4's scope-safe guarantees: prewired names are a documented, stable, globally
unique set (PascalCase, no namespace prefix needed for v1), enforced by a uniqueness test. Making
resolution `source`-aware is a change to `@flowlet/core`'s registry and `flowlet-react`'s `StubRenderer`,
which F4 does **not** own — it is flagged here as a recommendation for F1/F3a.

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
