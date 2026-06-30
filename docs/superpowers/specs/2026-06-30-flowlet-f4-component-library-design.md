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

## 4. Single source of truth (no drift)

The core unit is one **manifest entry** per component:

```
{ name, description, propsSchema (Zod), Component (React) }
```

From the manifest array the package mechanically derives the two F1 artifacts so they can never drift:

- **`prewiredComponents: RegisteredComponent[]`** — strips `Component`, stamps `source: "prewired"`.
  This is the LLM-facing menu handed to `FlowletProvider`.
- **`prewiredImpls: Record<string, ComponentType>`** — `name → wrapper`, handed to `StubRenderer`
  today and the F3 stage later.

A test asserts the two are in perfect correspondence (every descriptor has exactly one impl and vice
versa, names unique).

## 5. The registered set (~15 components)

All wrappers take **strictly serializable JSON props** — no React nodes, no functions in any schema —
because props travel agent → renderer as JSON. Icons are referenced by string name and resolved inside
the wrapper. Each wrapper adapts JSON props to Crayon's real prop shapes (which take React nodes).

**Content / display:** Card, Table, Chart (`kind`: bar | line | area | pie), Accordion, Carousel,
Callout, Tags, Steps, List, Image, ImageGallery, Markdown, CodeBlock, Tabs.

**Forms:** a single **Form** component whose `fields[]` is a discriminated union over every input type
(text, number, textarea, select, checkbox, radio, switch, toggle, slider, date) plus a submit label.
One clean menu entry covering the whole input surface. Submission is **declarative only** in F4 — fields
render as real Crayon inputs, but submit is a no-op / optional local callback. The action-chokepoint
transport is owned by F3; wiring lands there to avoid building on an unrouted seam.

**Excluded — chat-shell / runtime chrome (F5's job, not the agent's menu):** OpenUIChat, AgentInterface,
ToolCall, ToolResult, FollowUpBlock/Item, MessageLoading, Skeleton, Modal. Registering these would let
the agent render chat-app chrome inside its own output.

**Folded into parents (not registered standalone):** CardHeader, ListItem, RadioItem, CheckBoxItem,
SwitchItem, ToggleItem, Tag, Label — child-only primitives that would only add LLM-menu noise.

Each component needs a hand-authored `description` tuned for LLM selection; this is the main per-component
cost, alongside the serializable schema and wrapper.

## 6. Theming (brand → Crayon)

A small, **serializable** `BrandTokens` type:

```
{ accent, background, surface, text, mutedText, fontFamily, radius, mode? }
```

and a `FlowletThemeProvider brand={...}` that maps tokens → Crayon's `ThemeProvider` theme object + mode.
The host never touches Crayon's theme internals, and plain-object tokens cross the F3 sandbox postMessage
bridge cleanly (per F1 decision #4: theme is proxied into the sandbox). Ships with one default brand for
the example.

## 7. Data flow

Agent emits a `component` UINode (`name` + JSON `props`) → `StubRenderer` resolves the name against the
registry built from `prewiredComponents` → renders `prewiredImpls[name]` inside `FlowletThemeProvider`.
This is the identical seam the F3 sandbox stage will consume.

## 8. Verification

Vitest + `@testing-library/react` + jsdom (mirrors `flowlet-react`'s setup):

- each schema accepts representative valid props and rejects invalid ones;
- descriptor ↔ impl correspondence is exact (§4);
- every component renders expected themed content under `FlowletThemeProvider`;
- `BrandTokens` map to a valid Crayon theme object.

Plus a new **`examples/components`** page that renders every component themed via `StubRenderer` with
sample props — visible proof without touching the shared `examples/basic` page.

## 9. Build sequencing

Prove the full pattern (manifest → derived artifacts → serializable wrapper → theming → tests → example)
on a representative slice first: **Card** (container), **Table** (data), **Chart** (viz), **Form**
(interactive union). Once the pattern holds, the remaining wrappers are near-identical and fan out
mechanically.

## 10. Open implementation notes

- Exact Crayon export subpaths and `ThemeProvider` theme-field names are confirmed against the installed
  package during implementation; the wrapper layer insulates consumers from them, and TDD surfaces any
  mismatch immediately.
- `Charts` vs `ChartsV2`: pick the current/stable one during implementation; the `Chart` wrapper's
  `kind`-based public schema is unaffected by the choice.
