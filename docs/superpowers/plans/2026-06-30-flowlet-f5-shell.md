# Flowlet F5 Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@flowlet/shell`, the native Flowlet product surface: three drop-in elements (tabbed page, command-bar overlay, designable slot) over one shared thread core, themed to the host, with integrations and persistence seams, rendering against the F1 stub renderer.

**Architecture:** A new package depends on `@flowlet/core` + `@flowlet/react`. A view-model hook (`useFlowletThread`) normalizes the F1 message stream into ordered render items. Small primitives render those items. `<FlowletThread>` assembles Landing + MessageList + Composer + IntegrationsRail. Three element wrappers add placement. Theming is CSS custom properties (`--flowlet-*`); generated UI renders through a swappable `RendererContext` (StubRenderer now, F3 later); persistence and integrations are interface seams with local default implementations.

**Tech Stack:** React 18, TypeScript (strict, `noUncheckedIndexedAccess`), `ai` 6 + `@ai-sdk/react` 3, Vitest + Testing Library (jsdom, globals), pnpm workspace, plain CSS.

**Design spec:** `docs/superpowers/specs/2026-06-30-flowlet-f5-shell-design.md`

---

## File structure

```
packages/flowlet-shell/
  package.json            # package manifest, deps on @flowlet/core + @flowlet/react
  tsconfig.json           # mirrors flowlet-react
  vitest.config.ts        # jsdom + globals
  src/
    styles.css            # --flowlet-* token defaults + component classes
    theme.ts              # FlowletTheme type + themeToStyle()
    context.tsx           # FlowletShellProvider, useShell, default renderNode
    use-flowlet-thread.ts # toThreadItems() + useFlowletThread()
    seams/
      store.ts            # Flowlet, FlowletStore, createLocalStore()
      integrations.ts     # Integration, FlowletIntegrations, createLocalIntegrations()
    components/
      StreamingText.tsx   # assistant/user text + caret
      ToolCall.tsx        # mono op block
      ApprovalCard.tsx    # approve / decline
      UINodeView.tsx      # delegates to renderNode
      VoiceButton.tsx     # stubbed mic affordance
      Composer.tsx        # input + mic + send/stop
      MessageList.tsx     # maps ThreadItem[] -> primitives
      SuggestionChips.tsx
      FlowGallery.tsx
      Landing.tsx         # greeting + chips + gallery
      IntegrationsRail.tsx
      IntegrationsPicker.tsx
      ConnectCard.tsx     # inline connect-to-continue
    FlowletThread.tsx     # shared core
    elements/
      FlowletOverlay.tsx
      FlowletSlot.tsx
      FlowletPage.tsx
    use-voice-input.ts    # stub voice seam
    index.ts              # public exports
```

**Provider model.** `<FlowletOverlay>` and `<FlowletSlot>` assume the host wraps them in `<FlowletProvider>` (F1) then `<FlowletShellProvider>`. `<FlowletPage>` is the exception: because each tab is an isolated conversation, the page mounts a fresh `<FlowletProvider>` + `<FlowletShellProvider>` subtree per open tab, sharing `store`/`integrations` instances passed as props. All open tabs stay mounted (hidden via the `hidden` attribute) to preserve per-tab state.

---

## Task 1: Scaffold the package

**Files:**
- Create: `packages/flowlet-shell/package.json`
- Create: `packages/flowlet-shell/tsconfig.json`
- Create: `packages/flowlet-shell/vitest.config.ts`
- Create: `packages/flowlet-shell/src/styles.css`
- Create: `packages/flowlet-shell/src/index.ts`
- Test: `packages/flowlet-shell/src/smoke.test.ts`

- [ ] **Step 1: Write the package manifest**

`packages/flowlet-shell/package.json`:

```json
{
  "name": "@flowlet/shell",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./styles.css": "./src/styles.css"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": { "react": "^18.0.0", "react-dom": "^18.0.0" },
  "dependencies": {
    "@ai-sdk/react": "3.0.30",
    "@flowlet/core": "workspace:*",
    "@flowlet/react": "workspace:*",
    "ai": "6.0.28"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "jsdom": "^25.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "zod": "^3.24.0"
  }
}
```

- [ ] **Step 2: Write tsconfig and vitest config**

`packages/flowlet-shell/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

`packages/flowlet-shell/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "jsdom", globals: true, css: false } });
```

- [ ] **Step 3: Write the styles and a placeholder entry**

`packages/flowlet-shell/src/styles.css`:

```css
.flowlet-root {
  --flowlet-accent: light-dark(#16181d, #e9eaee);
  --flowlet-accent-fg: light-dark(#ffffff, #141417);
  --flowlet-fg: light-dark(#1b1d22, #e7e8ec);
  --flowlet-fg-muted: light-dark(#8a8c92, #7c7e86);
  --flowlet-bg: light-dark(#fcfcfb, #101013);
  --flowlet-surface: light-dark(#ffffff, #17171b);
  --flowlet-border: light-dark(#e9e9e5, #26262c);
  --flowlet-radius: 13px;
  --flowlet-shadow: 0 6px 20px light-dark(rgba(27,30,37,.07), rgba(0,0,0,.4));
  --flowlet-font: inherit;
  --flowlet-font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--flowlet-fg);
  background: var(--flowlet-bg);
  font-family: var(--flowlet-font);
}
.fl-thread { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.fl-msglist { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.fl-turn-user { align-self: flex-end; background: var(--flowlet-accent); color: var(--flowlet-accent-fg);
  padding: 8px 12px; border-radius: 14px 14px 4px 14px; max-width: 80%; }
.fl-turn-assistant { align-self: flex-start; max-width: 92%; line-height: 1.55; }
.fl-caret { display: inline-block; width: 7px; height: 1em; background: var(--flowlet-accent);
  vertical-align: -2px; margin-left: 2px; }
.fl-tool { align-self: flex-start; font-family: var(--flowlet-font-mono); font-size: 11px;
  color: var(--flowlet-fg-muted); border: 1px solid var(--flowlet-border); border-radius: 7px; padding: 6px 9px; }
.fl-approval { align-self: flex-start; border: 1px solid var(--flowlet-border);
  border-radius: var(--flowlet-radius); padding: 12px; box-shadow: var(--flowlet-shadow);
  background: var(--flowlet-surface); max-width: 88%; }
.fl-approval-actions { display: flex; gap: 8px; margin-top: 10px; }
.fl-btn { border: 1px solid var(--flowlet-border); border-radius: 8px; padding: 7px 13px;
  font: 500 12px/1 var(--flowlet-font-mono); background: var(--flowlet-surface); color: var(--flowlet-fg); cursor: pointer; }
.fl-btn-primary { background: var(--flowlet-accent); color: var(--flowlet-accent-fg); border-color: var(--flowlet-accent); }
.fl-uinode { align-self: flex-start; width: 100%; }
.fl-composer { display: flex; align-items: center; gap: 10px; margin: 12px; padding: 10px 13px;
  background: var(--flowlet-surface); border: 1px solid var(--flowlet-border);
  border-radius: var(--flowlet-radius); box-shadow: var(--flowlet-shadow); }
.fl-composer input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--flowlet-fg);
  font-family: var(--flowlet-font-mono); font-size: 13px; }
.fl-icon-btn { width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--flowlet-border);
  background: var(--flowlet-surface); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.fl-send { background: var(--flowlet-accent); color: var(--flowlet-accent-fg); border-color: var(--flowlet-accent); }
.fl-landing { display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; flex: 1; padding: 28px; text-align: center; }
.fl-greet { font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
.fl-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.fl-chip { border: 1px solid var(--flowlet-border); background: var(--flowlet-surface);
  border-radius: 999px; padding: 6px 12px; font-size: 12px; color: var(--flowlet-fg); cursor: pointer; }
.fl-gallery { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; width: 100%; max-width: 460px; }
.fl-flowcard { border: 1px solid var(--flowlet-border); border-radius: var(--flowlet-radius);
  padding: 12px; text-align: left; background: var(--flowlet-surface); cursor: pointer; }
.fl-rail { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 12px; }
.fl-rail-chip { display: flex; align-items: center; gap: 7px; border: 1px solid var(--flowlet-border);
  border-radius: 999px; padding: 5px 11px; font-size: 12px; background: var(--flowlet-surface); }
.fl-rail-dot { width: 6px; height: 6px; border-radius: 50%; background: #3fae6a; }
.fl-rail-connect { border: 1px dashed var(--flowlet-fg-muted); border-radius: 999px;
  padding: 6px 12px; font-size: 12px; background: transparent; color: var(--flowlet-fg); cursor: pointer; }
.fl-picker { border: 1px solid var(--flowlet-border); border-radius: var(--flowlet-radius);
  background: var(--flowlet-surface); box-shadow: var(--flowlet-shadow); overflow: hidden; }
.fl-picker-item { display: flex; align-items: center; gap: 9px; padding: 8px 11px; font-size: 13px; }
.fl-connect { border: 1px solid var(--flowlet-border); border-radius: var(--flowlet-radius);
  padding: 13px; background: var(--flowlet-surface); max-width: 430px; }
.fl-overlay-scrim { position: fixed; inset: 0; background: rgba(27,29,34,.26); }
.fl-overlay-panel { position: fixed; left: 50%; top: 12%; transform: translateX(-50%);
  width: min(560px, 92vw); background: var(--flowlet-surface); border: 1px solid var(--flowlet-border);
  border-radius: 16px; box-shadow: 0 24px 60px rgba(27,29,34,.35); overflow: hidden; }
.fl-launcher { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--flowlet-border);
  border-radius: 999px; padding: 9px 13px; background: var(--flowlet-surface);
  box-shadow: var(--flowlet-shadow); cursor: pointer; }
.fl-tabbar { display: flex; align-items: center; gap: 4px; padding: 8px 11px 0;
  border-bottom: 1px solid var(--flowlet-border); }
.fl-tab { display: flex; align-items: center; gap: 7px; padding: 8px 12px; font-size: 12.5px;
  color: var(--flowlet-fg-muted); border: 1px solid transparent; border-bottom: none;
  border-radius: 9px 9px 0 0; cursor: pointer; }
.fl-tab[aria-selected="true"] { color: var(--flowlet-fg); background: var(--flowlet-surface); border-color: var(--flowlet-border); }
.fl-slot-empty { border: 1.5px dashed var(--flowlet-fg-muted); border-radius: var(--flowlet-radius);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 22px; cursor: pointer; background: var(--flowlet-surface); color: var(--flowlet-fg); }
```

`packages/flowlet-shell/src/index.ts`:

```ts
export const SHELL_PACKAGE = "@flowlet/shell";
```

- [ ] **Step 4: Write the smoke test**

`packages/flowlet-shell/src/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SHELL_PACKAGE } from "./index";

describe("scaffold", () => {
  it("exports the package marker", () => {
    expect(SHELL_PACKAGE).toBe("@flowlet/shell");
  });
});
```

- [ ] **Step 5: Install workspace deps and run the test**

Run: `pnpm install` (from repo root, links the new workspace package)
Then run: `pnpm --filter @flowlet/shell test`
Expected: 1 passing test.

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-shell pnpm-lock.yaml
git commit -m "feat(flowlet-shell): scaffold package + tokens"
```

---

## Task 2: Theme tokens

**Files:**
- Create: `packages/flowlet-shell/src/theme.ts`
- Test: `packages/flowlet-shell/src/theme.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/theme.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { themeToStyle } from "./theme";

describe("themeToStyle", () => {
  it("returns an empty object for no theme", () => {
    expect(themeToStyle()).toEqual({});
  });

  it("maps provided tokens to --flowlet-* custom properties", () => {
    const style = themeToStyle({ accent: "#f00", radius: "20px" }) as Record<string, string>;
    expect(style["--flowlet-accent"]).toBe("#f00");
    expect(style["--flowlet-radius"]).toBe("20px");
    expect(style["--flowlet-bg"]).toBeUndefined();
  });

  it("sets colorScheme when scheme is given", () => {
    const style = themeToStyle({ scheme: "dark" }) as Record<string, string>;
    expect(style.colorScheme).toBe("dark");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test theme`
Expected: FAIL ("Cannot find module './theme'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/theme.ts`:

```ts
import type { CSSProperties } from "react";

export type FlowletScheme = "light" | "dark" | "auto";

export interface FlowletTheme {
  accent?: string;
  accentFg?: string;
  fg?: string;
  fgMuted?: string;
  bg?: string;
  surface?: string;
  border?: string;
  radius?: string;
  shadow?: string;
  font?: string;
  fontMono?: string;
  scheme?: FlowletScheme;
}

const TOKEN_VARS: Record<Exclude<keyof FlowletTheme, "scheme">, string> = {
  accent: "--flowlet-accent",
  accentFg: "--flowlet-accent-fg",
  fg: "--flowlet-fg",
  fgMuted: "--flowlet-fg-muted",
  bg: "--flowlet-bg",
  surface: "--flowlet-surface",
  border: "--flowlet-border",
  radius: "--flowlet-radius",
  shadow: "--flowlet-shadow",
  font: "--flowlet-font",
  fontMono: "--flowlet-font-mono",
};

/** Maps a partial theme to inline CSS custom properties + colorScheme. */
export function themeToStyle(theme: FlowletTheme = {}): CSSProperties {
  const style: Record<string, string> = {};
  for (const key of Object.keys(TOKEN_VARS) as (keyof typeof TOKEN_VARS)[]) {
    const value = theme[key];
    if (value !== undefined) style[TOKEN_VARS[key]] = value;
  }
  if (theme.scheme && theme.scheme !== "auto") style.colorScheme = theme.scheme;
  if (theme.scheme === "auto") style.colorScheme = "light dark";
  return style as CSSProperties;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test theme`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/theme.ts packages/flowlet-shell/src/theme.test.ts
git commit -m "feat(flowlet-shell): theme token mapping"
```

---

## Task 3: FlowletStore seam

**Files:**
- Create: `packages/flowlet-shell/src/seams/store.ts`
- Test: `packages/flowlet-shell/src/seams/store.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/seams/store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { UINode } from "@flowlet/core";
import { createLocalStore } from "./store";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

describe("createLocalStore", () => {
  it("saves and lists flowlets", async () => {
    const store = createLocalStore();
    const saved = await store.save({ id: "f1", name: "Spending", node });
    expect(saved.name).toBe("Spending");
    expect(typeof saved.updatedAt).toBe("number");
    expect(await store.list()).toHaveLength(1);
  });

  it("loads by id and removes", async () => {
    const store = createLocalStore();
    await store.save({ id: "f1", name: "Spending", node });
    expect((await store.load("f1"))?.name).toBe("Spending");
    await store.remove("f1");
    expect(await store.load("f1")).toBeNull();
  });

  it("seeds from initial flowlets", async () => {
    const store = createLocalStore([{ id: "s", name: "Seed", node, updatedAt: 1 }]);
    expect(await store.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test store`
Expected: FAIL ("Cannot find module './store'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/seams/store.ts`:

```ts
import type { UINode } from "@flowlet/core";

/** A saved flowlet: a generated UI node plus identity. Persisted by Flowlet. */
export interface Flowlet {
  id: string;
  name: string;
  node: UINode;
  updatedAt: number;
}

export type FlowletDraft = Omit<Flowlet, "updatedAt"> & { updatedAt?: number };

/** Flowlet-owned persistence seam. The real client (sharing, cron) lands in F6/F7. */
export interface FlowletStore {
  list(): Promise<Flowlet[]>;
  load(id: string): Promise<Flowlet | null>;
  save(draft: FlowletDraft): Promise<Flowlet>;
  remove(id: string): Promise<void>;
}

let clock = 0;

/** In-memory default. Deterministic clock so tests need no Date.now(). */
export function createLocalStore(seed: Flowlet[] = []): FlowletStore {
  const map = new Map<string, Flowlet>(seed.map((f) => [f.id, f]));
  return {
    async list() {
      return [...map.values()];
    },
    async load(id) {
      return map.get(id) ?? null;
    },
    async save(draft) {
      const flowlet: Flowlet = { ...draft, updatedAt: draft.updatedAt ?? ++clock };
      map.set(flowlet.id, flowlet);
      return flowlet;
    },
    async remove(id) {
      map.delete(id);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/seams/store.ts packages/flowlet-shell/src/seams/store.test.ts
git commit -m "feat(flowlet-shell): FlowletStore seam + local impl"
```

---

## Task 4: FlowletIntegrations seam

**Files:**
- Create: `packages/flowlet-shell/src/seams/integrations.ts`
- Test: `packages/flowlet-shell/src/seams/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/seams/integrations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createLocalIntegrations } from "./integrations";

describe("createLocalIntegrations", () => {
  it("lists seeded integrations", async () => {
    const ig = createLocalIntegrations([{ id: "gmail", name: "Gmail", connected: false }]);
    expect(await ig.list()).toHaveLength(1);
  });

  it("connects and disconnects by id", async () => {
    const ig = createLocalIntegrations([{ id: "gmail", name: "Gmail", connected: false }]);
    expect((await ig.connect("gmail")).connected).toBe(true);
    expect((await ig.disconnect("gmail")).connected).toBe(false);
  });

  it("throws on unknown id", async () => {
    const ig = createLocalIntegrations([]);
    await expect(ig.connect("nope")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test integrations`
Expected: FAIL ("Cannot find module './integrations'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/seams/integrations.ts`:

```ts
/** A connectable tool. Real Composio OAuth metadata is wired by F2. */
export interface Integration {
  id: string;
  name: string;
  connected: boolean;
  logo?: string;
}

/** Tool-connection seam. */
export interface FlowletIntegrations {
  list(): Promise<Integration[]>;
  connect(id: string): Promise<Integration>;
  disconnect(id: string): Promise<Integration>;
}

export function createLocalIntegrations(seed: Integration[]): FlowletIntegrations {
  const map = new Map<string, Integration>(seed.map((i) => [i.id, i]));
  const set = (id: string, connected: boolean): Integration => {
    const found = map.get(id);
    if (!found) throw new Error(`unknown integration: ${id}`);
    const next = { ...found, connected };
    map.set(id, next);
    return next;
  };
  return {
    async list() {
      return [...map.values()];
    },
    async connect(id) {
      return set(id, true);
    },
    async disconnect(id) {
      return set(id, false);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test integrations`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/seams/integrations.ts packages/flowlet-shell/src/seams/integrations.test.ts
git commit -m "feat(flowlet-shell): FlowletIntegrations seam + local impl"
```

---

## Task 5: Shell context + provider

**Files:**
- Create: `packages/flowlet-shell/src/context.tsx`
- Test: `packages/flowlet-shell/src/context.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/context.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider, useShell } from "./context";

function Probe() {
  const shell = useShell();
  return <div data-testid="probe">{[typeof shell.store.list, typeof shell.integrations.list, typeof shell.renderNode].join(",")}</div>;
}

describe("FlowletShellProvider", () => {
  it("provides store, integrations, and renderNode defaults", () => {
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider>
          <Probe />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("function,function,function");
  });

  it("applies the flowlet-root class", () => {
    const { container } = render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider>
          <span>hi</span>
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(container.querySelector(".flowlet-root")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test context`
Expected: FAIL ("Cannot find module './context'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/context.tsx`:

```tsx
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import type { UINode } from "@flowlet/core";
import { StubRenderer } from "@flowlet/react";
import { themeToStyle, type FlowletTheme } from "./theme";
import { createLocalStore, type FlowletStore } from "./seams/store";
import { createLocalIntegrations, type FlowletIntegrations } from "./seams/integrations";
import "./styles.css";

export type RenderNode = (node: UINode) => ReactNode;

export interface ShellContextValue {
  store: FlowletStore;
  integrations: FlowletIntegrations;
  renderNode: RenderNode;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export interface FlowletShellProviderProps {
  store?: FlowletStore;
  integrations?: FlowletIntegrations;
  /** Override the render surface. Default delegates to F1's StubRenderer. */
  renderNode?: RenderNode;
  /** Component impls for the default StubRenderer-backed renderNode. */
  impls?: Record<string, ComponentType<Record<string, unknown>>>;
  theme?: FlowletTheme;
  children: ReactNode;
}

export function FlowletShellProvider({
  store, integrations, renderNode, impls, theme, children,
}: FlowletShellProviderProps) {
  const value = useMemo<ShellContextValue>(() => ({
    store: store ?? createLocalStore(),
    integrations: integrations ?? createLocalIntegrations([]),
    renderNode: renderNode ?? ((node) => <StubRenderer node={node} impls={impls ?? {}} />),
  }), [store, integrations, renderNode, impls]);

  return (
    <ShellContext.Provider value={value}>
      <div className="flowlet-root" style={themeToStyle(theme)}>{children}</div>
    </ShellContext.Provider>
  );
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within a FlowletShellProvider");
  return ctx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test context`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/context.tsx packages/flowlet-shell/src/context.test.tsx
git commit -m "feat(flowlet-shell): shell context + provider + renderer seam"
```

---

## Task 6: View-model (useFlowletThread)

**Files:**
- Create: `packages/flowlet-shell/src/use-flowlet-thread.ts`
- Test: `packages/flowlet-shell/src/use-flowlet-thread.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/use-flowlet-thread.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { FlowletUIMessage } from "@flowlet/core";
import { toThreadItems } from "./use-flowlet-thread";

const msg = (id: string, role: "user" | "assistant", parts: unknown[]): FlowletUIMessage =>
  ({ id, role, parts } as unknown as FlowletUIMessage);

describe("toThreadItems", () => {
  it("flattens text parts with role", () => {
    const items = toThreadItems([msg("m1", "user", [{ type: "text", text: "hi" }])]);
    expect(items).toEqual([{ kind: "text", key: "m1:0", role: "user", text: "hi" }]);
  });

  it("emits an approval item for a tool part awaiting approval", () => {
    const items = toThreadItems([
      msg("m2", "assistant", [
        { type: "tool-budgetCreate", state: "approval-requested", approval: { id: "a1" }, input: { cap: 2000 } },
      ]),
    ]);
    expect(items[0]).toEqual({
      kind: "approval", key: "m2:0", approvalId: "a1", toolName: "budgetCreate", input: { cap: 2000 },
    });
  });

  it("emits a tool item for other tool states and a ui item for data-ui", () => {
    const items = toThreadItems([
      msg("m3", "assistant", [
        { type: "tool-budgetCreate", state: "output-available" },
        { type: "data-ui", id: "ui-1", data: { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} } },
      ]),
    ]);
    expect(items[0]).toEqual({ kind: "tool", key: "m3:0", toolName: "budgetCreate", state: "output-available" });
    expect(items[1]).toMatchObject({ kind: "ui", key: "m3:1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test use-flowlet-thread`
Expected: FAIL ("Cannot find module './use-flowlet-thread'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/use-flowlet-thread.ts`:

```ts
import { useMemo } from "react";
import type { FlowletUIMessage } from "@flowlet/core";
import type { UINode } from "@flowlet/core";
import { useFlowletChat } from "@flowlet/react";

export type ThreadItem =
  | { kind: "text"; key: string; role: "user" | "assistant"; text: string }
  | { kind: "tool"; key: string; toolName: string; state: string }
  | { kind: "approval"; key: string; approvalId: string; toolName: string; input: unknown }
  | { kind: "ui"; key: string; node: UINode };

/** Pure normalizer: flattens message parts into ordered render items. */
export function toThreadItems(messages: FlowletUIMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const message of messages) {
    const role = message.role === "user" ? "user" : "assistant";
    message.parts.forEach((rawPart, index) => {
      const part = rawPart as { type: string; [k: string]: unknown };
      const key = `${message.id}:${index}`;
      if (part.type === "text") {
        items.push({ kind: "text", key, role, text: String(part.text ?? "") });
      } else if (part.type === "data-ui") {
        items.push({ kind: "ui", key, node: part.data as UINode });
      } else if (part.type.startsWith("tool-")) {
        const toolName = part.type.slice("tool-".length);
        if (part.state === "approval-requested") {
          const approval = part.approval as { id: string };
          items.push({ kind: "approval", key, approvalId: approval.id, toolName, input: part.input });
        } else {
          items.push({ kind: "tool", key, toolName, state: String(part.state ?? "") });
        }
      }
    });
  }
  return items;
}

/** Hook: F1 chat plus the normalized item list. */
export function useFlowletThread() {
  const chat = useFlowletChat();
  const items = useMemo(() => toThreadItems(chat.messages), [chat.messages]);
  return { ...chat, items };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test use-flowlet-thread`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/use-flowlet-thread.ts packages/flowlet-shell/src/use-flowlet-thread.test.ts
git commit -m "feat(flowlet-shell): useFlowletThread view-model"
```

---

## Task 7: StreamingText + ToolCall primitives

**Files:**
- Create: `packages/flowlet-shell/src/components/StreamingText.tsx`
- Create: `packages/flowlet-shell/src/components/ToolCall.tsx`
- Test: `packages/flowlet-shell/src/components/primitives.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/components/primitives.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StreamingText } from "./StreamingText";
import { ToolCall } from "./ToolCall";

describe("StreamingText", () => {
  it("renders text and shows a caret while streaming", () => {
    const { rerender, container } = render(<StreamingText text="hello" />);
    expect(screen.getByText("hello")).toBeTruthy();
    expect(container.querySelector(".fl-caret")).toBeNull();
    rerender(<StreamingText text="hello" streaming />);
    expect(container.querySelector(".fl-caret")).not.toBeNull();
  });
});

describe("ToolCall", () => {
  it("renders the tool name and state", () => {
    render(<ToolCall toolName="budgetCreate" state="output-available" />);
    expect(screen.getByText(/budgetCreate/)).toBeTruthy();
    expect(screen.getByText(/output-available/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test primitives`
Expected: FAIL ("Cannot find module './StreamingText'").

- [ ] **Step 3: Write the implementations**

`packages/flowlet-shell/src/components/StreamingText.tsx`:

```tsx
export interface StreamingTextProps {
  text: string;
  streaming?: boolean;
}

export function StreamingText({ text, streaming = false }: StreamingTextProps) {
  return (
    <span>
      {text}
      {streaming && <span className="fl-caret" aria-hidden="true" />}
    </span>
  );
}
```

`packages/flowlet-shell/src/components/ToolCall.tsx`:

```tsx
export interface ToolCallProps {
  toolName: string;
  state: string;
}

export function ToolCall({ toolName, state }: ToolCallProps) {
  return (
    <div className="fl-tool" data-testid="tool-call">
      <span>● {toolName}</span> <span>{state}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test primitives`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/components/StreamingText.tsx packages/flowlet-shell/src/components/ToolCall.tsx packages/flowlet-shell/src/components/primitives.test.tsx
git commit -m "feat(flowlet-shell): StreamingText + ToolCall primitives"
```

---

## Task 8: ApprovalCard + UINodeView

**Files:**
- Create: `packages/flowlet-shell/src/components/ApprovalCard.tsx`
- Create: `packages/flowlet-shell/src/components/UINodeView.tsx`
- Test: `packages/flowlet-shell/src/components/approval-uinode.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/components/approval-uinode.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createStubAgent, type UINode } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { ApprovalCard } from "./ApprovalCard";
import { UINodeView } from "./UINodeView";

describe("ApprovalCard", () => {
  it("calls onApprove and onDecline", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(<ApprovalCard toolName="budgetCreate" input={{ cap: 2000 }} onApprove={onApprove} onDecline={onDecline} />);
    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Decline"));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });
});

describe("UINodeView", () => {
  it("delegates rendering to the shell renderNode", () => {
    const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered">ok</div>}>
          <UINodeView node={node} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(screen.getByTestId("rendered")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test approval-uinode`
Expected: FAIL ("Cannot find module './ApprovalCard'").

- [ ] **Step 3: Write the implementations**

`packages/flowlet-shell/src/components/ApprovalCard.tsx`:

```tsx
export interface ApprovalCardProps {
  toolName: string;
  input: unknown;
  onApprove: () => void;
  onDecline: () => void;
}

export function ApprovalCard({ toolName, input, onApprove, onDecline }: ApprovalCardProps) {
  return (
    <div className="fl-approval" role="group" aria-label={`Approve ${toolName}`}>
      <div style={{ fontFamily: "var(--flowlet-font-mono)", fontSize: 11 }}>approval required · {toolName}</div>
      <pre style={{ fontSize: 11, margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{JSON.stringify(input, null, 2)}</pre>
      <div className="fl-approval-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onApprove}>Approve</button>
        <button type="button" className="fl-btn" onClick={onDecline}>Decline</button>
      </div>
    </div>
  );
}
```

`packages/flowlet-shell/src/components/UINodeView.tsx`:

```tsx
import type { UINode } from "@flowlet/core";
import { useShell } from "../context";

export interface UINodeViewProps {
  node: UINode;
}

export function UINodeView({ node }: UINodeViewProps) {
  const { renderNode } = useShell();
  return <div className="fl-uinode" data-testid="ui-node">{renderNode(node)}</div>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test approval-uinode`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/components/ApprovalCard.tsx packages/flowlet-shell/src/components/UINodeView.tsx packages/flowlet-shell/src/components/approval-uinode.test.tsx
git commit -m "feat(flowlet-shell): ApprovalCard + UINodeView"
```

---

## Task 9: VoiceButton + voice seam + Composer

**Files:**
- Create: `packages/flowlet-shell/src/use-voice-input.ts`
- Create: `packages/flowlet-shell/src/components/VoiceButton.tsx`
- Create: `packages/flowlet-shell/src/components/Composer.tsx`
- Test: `packages/flowlet-shell/src/components/composer.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/components/composer.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "./Composer";
import { useVoiceInput } from "../use-voice-input";

describe("useVoiceInput", () => {
  it("reports unsupported by default", () => {
    const v = useVoiceInput();
    expect(v.supported).toBe(false);
    expect(v.state).toBe("disabled");
  });
});

describe("Composer", () => {
  it("sends trimmed text on Enter and clears the input", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByPlaceholderText("ask anything") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "show my spending" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("show my spending");
    expect(input.value).toBe("");
  });

  it("does not send empty text", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByPlaceholderText("ask anything");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a stop button while streaming and calls onStop", () => {
    const onStop = vi.fn();
    render(<Composer onSend={() => {}} status="streaming" onStop={onStop} />);
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test composer`
Expected: FAIL ("Cannot find module './Composer'").

- [ ] **Step 3: Write the implementations**

`packages/flowlet-shell/src/use-voice-input.ts`:

```ts
export type VoiceState = "idle" | "recording" | "disabled";

export interface VoiceInput {
  supported: boolean;
  state: VoiceState;
  toggle: () => void;
}

/** Stub seam. A real capture pipeline replaces this later. */
export function useVoiceInput(): VoiceInput {
  return { supported: false, state: "disabled", toggle: () => {} };
}
```

`packages/flowlet-shell/src/components/VoiceButton.tsx`:

```tsx
import type { VoiceState } from "../use-voice-input";

export interface VoiceButtonProps {
  state?: VoiceState;
  onClick?: () => void;
}

export function VoiceButton({ state = "disabled", onClick }: VoiceButtonProps) {
  return (
    <button
      type="button"
      className="fl-icon-btn"
      aria-label="Voice input"
      disabled={state === "disabled"}
      aria-pressed={state === "recording"}
      onClick={onClick}
    >
      🎤
    </button>
  );
}
```

`packages/flowlet-shell/src/components/Composer.tsx`:

```tsx
import { useState, type KeyboardEvent } from "react";
import { VoiceButton } from "./VoiceButton";
import { useVoiceInput } from "../use-voice-input";

export interface ComposerProps {
  onSend: (text: string) => void;
  status?: string;
  onStop?: () => void;
  placeholder?: string;
}

export function Composer({ onSend, status, onStop, placeholder = "ask anything" }: ComposerProps) {
  const [value, setValue] = useState("");
  const voice = useVoiceInput();
  const streaming = status === "streaming" || status === "submitted";

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="fl-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Message"
      />
      <VoiceButton state={voice.state} onClick={voice.toggle} />
      {streaming && onStop ? (
        <button type="button" className="fl-icon-btn" aria-label="Stop" onClick={onStop}>■</button>
      ) : (
        <button type="submit" className="fl-icon-btn fl-send" aria-label="Send">↑</button>
      )}
    </form>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test composer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/use-voice-input.ts packages/flowlet-shell/src/components/VoiceButton.tsx packages/flowlet-shell/src/components/Composer.tsx packages/flowlet-shell/src/components/composer.test.tsx
git commit -m "feat(flowlet-shell): Composer + stubbed voice affordance"
```

---

## Task 10: MessageList

**Files:**
- Create: `packages/flowlet-shell/src/components/MessageList.tsx`
- Test: `packages/flowlet-shell/src/components/message-list.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/components/message-list.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createStubAgent, type UINode } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { MessageList } from "./MessageList";
import type { ThreadItem } from "../use-flowlet-thread";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

function renderList(items: ThreadItem[], onApprove = vi.fn()) {
  return render(
    <FlowletProvider agent={createStubAgent()} components={[]}>
      <FlowletShellProvider renderNode={() => <div data-testid="rendered" />}>
        <MessageList items={items} status="ready" onApprove={onApprove} />
      </FlowletShellProvider>
    </FlowletProvider>,
  );
}

describe("MessageList", () => {
  it("renders text, tool, approval, and ui items, and is a log", () => {
    const onApprove = vi.fn();
    renderList([
      { kind: "text", key: "a", role: "assistant", text: "hello" },
      { kind: "tool", key: "b", toolName: "q", state: "output-available" },
      { kind: "approval", key: "c", approvalId: "a1", toolName: "budgetCreate", input: {} },
      { kind: "ui", key: "d", node },
    ], onApprove);
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByTestId("tool-call")).toBeTruthy();
    expect(screen.getByTestId("ui-node")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledWith("a1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test message-list`
Expected: FAIL ("Cannot find module './MessageList'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/components/MessageList.tsx`:

```tsx
import type { ThreadItem } from "../use-flowlet-thread";
import { StreamingText } from "./StreamingText";
import { ToolCall } from "./ToolCall";
import { ApprovalCard } from "./ApprovalCard";
import { UINodeView } from "./UINodeView";

export interface MessageListProps {
  items: ThreadItem[];
  status?: string;
  onApprove: (approvalId: string) => void;
  onDecline?: (approvalId: string) => void;
}

export function MessageList({ items, status, onApprove, onDecline }: MessageListProps) {
  const lastTextKey = [...items].reverse().find((i) => i.kind === "text")?.key;
  return (
    <div className="fl-msglist" role="log" aria-live="polite">
      {items.map((item) => {
        switch (item.kind) {
          case "text":
            return (
              <div key={item.key} className={item.role === "user" ? "fl-turn-user" : "fl-turn-assistant"}>
                <StreamingText text={item.text} streaming={status === "streaming" && item.key === lastTextKey} />
              </div>
            );
          case "tool":
            return <ToolCall key={item.key} toolName={item.toolName} state={item.state} />;
          case "approval":
            return (
              <ApprovalCard
                key={item.key}
                toolName={item.toolName}
                input={item.input}
                onApprove={() => onApprove(item.approvalId)}
                onDecline={() => onDecline?.(item.approvalId)}
              />
            );
          case "ui":
            return <UINodeView key={item.key} node={item.node} />;
        }
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test message-list`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/components/MessageList.tsx packages/flowlet-shell/src/components/message-list.test.tsx
git commit -m "feat(flowlet-shell): MessageList"
```

---

## Task 11: Landing + SuggestionChips + FlowGallery

**Files:**
- Create: `packages/flowlet-shell/src/components/SuggestionChips.tsx`
- Create: `packages/flowlet-shell/src/components/FlowGallery.tsx`
- Create: `packages/flowlet-shell/src/components/Landing.tsx`
- Test: `packages/flowlet-shell/src/components/landing.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/components/landing.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SuggestionChips } from "./SuggestionChips";
import { FlowGallery } from "./FlowGallery";
import { Landing } from "./Landing";
import type { Flowlet } from "../seams/store";

const flows: Flowlet[] = [{ id: "f1", name: "Spending", node: { id: "n", kind: "generated", payload: {} }, updatedAt: 1 }];

describe("SuggestionChips", () => {
  it("calls onSelect with the chip text", () => {
    const onSelect = vi.fn();
    render(<SuggestionChips suggestions={["Show my spending"]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Show my spending"));
    expect(onSelect).toHaveBeenCalledWith("Show my spending");
  });
});

describe("FlowGallery", () => {
  it("calls onOpen with the flow", () => {
    const onOpen = vi.fn();
    render(<FlowGallery flows={flows} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Spending"));
    expect(onOpen).toHaveBeenCalledWith(flows[0]);
  });
});

describe("Landing", () => {
  it("shows greeting, chips, and gallery", () => {
    render(
      <Landing
        greeting="What can I build?"
        suggestions={["Set a budget"]}
        flows={flows}
        onSuggestion={() => {}}
        onOpenFlow={() => {}}
      />,
    );
    expect(screen.getByText("What can I build?")).toBeTruthy();
    expect(screen.getByText("Set a budget")).toBeTruthy();
    expect(screen.getByText("Spending")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test landing`
Expected: FAIL ("Cannot find module './SuggestionChips'").

- [ ] **Step 3: Write the implementations**

`packages/flowlet-shell/src/components/SuggestionChips.tsx`:

```tsx
export interface SuggestionChipsProps {
  suggestions: string[];
  onSelect: (text: string) => void;
}

export function SuggestionChips({ suggestions, onSelect }: SuggestionChipsProps) {
  if (suggestions.length === 0) return null;
  return (
    <div className="fl-chips">
      {suggestions.map((s) => (
        <button type="button" key={s} className="fl-chip" onClick={() => onSelect(s)}>{s}</button>
      ))}
    </div>
  );
}
```

`packages/flowlet-shell/src/components/FlowGallery.tsx`:

```tsx
import type { Flowlet } from "../seams/store";

export interface FlowGalleryProps {
  flows: Flowlet[];
  onOpen: (flow: Flowlet) => void;
}

export function FlowGallery({ flows, onOpen }: FlowGalleryProps) {
  if (flows.length === 0) return null;
  return (
    <div className="fl-gallery">
      {flows.map((f) => (
        <button type="button" key={f.id} className="fl-flowcard" onClick={() => onOpen(f)}>{f.name}</button>
      ))}
    </div>
  );
}
```

`packages/flowlet-shell/src/components/Landing.tsx`:

```tsx
import type { Flowlet } from "../seams/store";
import { SuggestionChips } from "./SuggestionChips";
import { FlowGallery } from "./FlowGallery";

export interface LandingProps {
  greeting?: string;
  suggestions?: string[];
  flows?: Flowlet[];
  onSuggestion: (text: string) => void;
  onOpenFlow: (flow: Flowlet) => void;
}

export function Landing({
  greeting = "What can I help you build?", suggestions = [], flows = [], onSuggestion, onOpenFlow,
}: LandingProps) {
  return (
    <div className="fl-landing">
      <div className="fl-greet">{greeting}</div>
      <SuggestionChips suggestions={suggestions} onSelect={onSuggestion} />
      <FlowGallery flows={flows} onOpen={onOpenFlow} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test landing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/components/SuggestionChips.tsx packages/flowlet-shell/src/components/FlowGallery.tsx packages/flowlet-shell/src/components/Landing.tsx packages/flowlet-shell/src/components/landing.test.tsx
git commit -m "feat(flowlet-shell): Landing + SuggestionChips + FlowGallery"
```

---

## Task 12: IntegrationsRail + IntegrationsPicker + ConnectCard

**Files:**
- Create: `packages/flowlet-shell/src/components/IntegrationsRail.tsx`
- Create: `packages/flowlet-shell/src/components/IntegrationsPicker.tsx`
- Create: `packages/flowlet-shell/src/components/ConnectCard.tsx`
- Test: `packages/flowlet-shell/src/components/integrations.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/components/integrations.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IntegrationsRail } from "./IntegrationsRail";
import { IntegrationsPicker } from "./IntegrationsPicker";
import { ConnectCard } from "./ConnectCard";
import type { Integration } from "../seams/integrations";

const list: Integration[] = [
  { id: "plaid", name: "Plaid", connected: true },
  { id: "gmail", name: "Gmail", connected: false },
];

describe("IntegrationsRail", () => {
  it("shows connected integrations and a connect action", () => {
    const onConnectClick = vi.fn();
    render(<IntegrationsRail integrations={list} onConnectClick={onConnectClick} />);
    expect(screen.getByText("Plaid")).toBeTruthy();
    expect(screen.queryByText("Gmail")).toBeNull();
    fireEvent.click(screen.getByText("+ Connect tools"));
    expect(onConnectClick).toHaveBeenCalledOnce();
  });
});

describe("IntegrationsPicker", () => {
  it("connects a disconnected integration", () => {
    const onConnect = vi.fn();
    render(<IntegrationsPicker integrations={list} onConnect={onConnect} onDisconnect={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Connect"));
    expect(onConnect).toHaveBeenCalledWith("gmail");
  });
});

describe("ConnectCard", () => {
  it("renders reason and triggers connect", () => {
    const onConnect = vi.fn();
    render(<ConnectCard integration={list[1]!} reason="read your invoices" onConnect={onConnect} />);
    expect(screen.getByText(/read your invoices/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test components/integrations`
Expected: FAIL ("Cannot find module './IntegrationsRail'").

- [ ] **Step 3: Write the implementations**

`packages/flowlet-shell/src/components/IntegrationsRail.tsx`:

```tsx
import type { Integration } from "../seams/integrations";

export interface IntegrationsRailProps {
  integrations: Integration[];
  onConnectClick: () => void;
}

export function IntegrationsRail({ integrations, onConnectClick }: IntegrationsRailProps) {
  const connected = integrations.filter((i) => i.connected);
  return (
    <div className="fl-rail" aria-label="Connected tools">
      {connected.map((i) => (
        <span key={i.id} className="fl-rail-chip"><span className="fl-rail-dot" />{i.name}</span>
      ))}
      <button type="button" className="fl-rail-connect" onClick={onConnectClick}>+ Connect tools</button>
    </div>
  );
}
```

`packages/flowlet-shell/src/components/IntegrationsPicker.tsx`:

```tsx
import { useState } from "react";
import type { Integration } from "../seams/integrations";

export interface IntegrationsPickerProps {
  integrations: Integration[];
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onClose: () => void;
}

export function IntegrationsPicker({ integrations, onConnect, onDisconnect, onClose }: IntegrationsPickerProps) {
  const [query, setQuery] = useState("");
  const shown = integrations.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="fl-picker" role="dialog" aria-label="Integrations">
      <input
        className="fl-picker-item"
        placeholder="search integrations…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search integrations"
      />
      {shown.map((i) => (
        <div key={i.id} className="fl-picker-item">
          <span>{i.name}</span>
          {i.connected ? (
            <button type="button" className="fl-btn" style={{ marginLeft: "auto" }} onClick={() => onDisconnect(i.id)}>Disconnect</button>
          ) : (
            <button type="button" className="fl-btn fl-btn-primary" style={{ marginLeft: "auto" }} onClick={() => onConnect(i.id)}>Connect</button>
          )}
        </div>
      ))}
      <button type="button" className="fl-btn" onClick={onClose}>Close</button>
    </div>
  );
}
```

`packages/flowlet-shell/src/components/ConnectCard.tsx`:

```tsx
import type { Integration } from "../seams/integrations";

export interface ConnectCardProps {
  integration: Integration;
  reason?: string;
  onConnect: () => void;
}

export function ConnectCard({ integration, reason, onConnect }: ConnectCardProps) {
  return (
    <div className="fl-connect" role="group" aria-label={`Connect ${integration.name}`}>
      <div style={{ fontWeight: 600 }}>Connect {integration.name}</div>
      {reason && <div style={{ fontSize: 12, margin: "6px 0 10px" }}>So I can {reason}.</div>}
      <button type="button" className="fl-btn fl-btn-primary" onClick={onConnect}>Connect {integration.name}</button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test components/integrations`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/components/IntegrationsRail.tsx packages/flowlet-shell/src/components/IntegrationsPicker.tsx packages/flowlet-shell/src/components/ConnectCard.tsx packages/flowlet-shell/src/components/integrations.test.tsx
git commit -m "feat(flowlet-shell): integrations rail, picker, connect card"
```

---

## Task 13: FlowletThread core

**Files:**
- Create: `packages/flowlet-shell/src/FlowletThread.tsx`
- Test: `packages/flowlet-shell/src/FlowletThread.test.tsx`

- [ ] **Step 1: Write the failing test (full HITL loop, mirrors F1's stub test)**

`packages/flowlet-shell/src/FlowletThread.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core";
import { z } from "zod";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "./context";
import { FlowletThread } from "./FlowletThread";

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

describe("FlowletThread end-to-end", () => {
  it("send -> approval -> approve -> renders the node", async () => {
    render(
      <FlowletProvider
        agent={createStubAgent()}
        components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
      >
        <FlowletShellProvider impls={{ DemoCard: DemoCard as never }}>
          <FlowletThread suggestions={["show me a card"]} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );

    fireEvent.click(screen.getByText("show me a card")); // suggestion chip sends
    await waitFor(() => screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => screen.getByTestId("demo-card"));
    expect(screen.getByTestId("demo-card").textContent).toBe("Hello from Flowlet");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test FlowletThread`
Expected: FAIL ("Cannot find module './FlowletThread'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/FlowletThread.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useFlowletThread } from "./use-flowlet-thread";
import { useShell } from "./context";
import type { Flowlet } from "./seams/store";
import type { Integration } from "./seams/integrations";
import { Landing } from "./components/Landing";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { IntegrationsRail } from "./components/IntegrationsRail";
import { IntegrationsPicker } from "./components/IntegrationsPicker";

export interface FlowletThreadProps {
  greeting?: string;
  suggestions?: string[];
  flows?: Flowlet[];
  onOpenFlow?: (flow: Flowlet) => void;
}

export function FlowletThread({ greeting, suggestions = [], flows = [], onOpenFlow }: FlowletThreadProps) {
  const chat = useFlowletThread();
  const { integrations } = useShell();
  const [tools, setTools] = useState<Integration[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refresh = () => { void integrations.list().then(setTools); };
  useEffect(refresh, [integrations]);

  const send = (text: string) => { void chat.sendMessage({ text }); };
  const approve = (id: string) => { void chat.addToolApprovalResponse({ id, approved: true }); };
  const decline = (id: string) => { void chat.addToolApprovalResponse({ id, approved: false }); };

  return (
    <div className="fl-thread">
      {chat.items.length === 0 ? (
        <Landing
          greeting={greeting}
          suggestions={suggestions}
          flows={flows}
          onSuggestion={send}
          onOpenFlow={(f) => onOpenFlow?.(f)}
        />
      ) : (
        <MessageList items={chat.items} status={chat.status} onApprove={approve} onDecline={decline} />
      )}
      {pickerOpen && (
        <IntegrationsPicker
          integrations={tools}
          onConnect={(id) => integrations.connect(id).then(refresh)}
          onDisconnect={(id) => integrations.disconnect(id).then(refresh)}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <IntegrationsRail integrations={tools} onConnectClick={() => setPickerOpen(true)} />
      <Composer onSend={send} status={chat.status} onStop={() => chat.stop()} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test FlowletThread`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/FlowletThread.tsx packages/flowlet-shell/src/FlowletThread.test.tsx
git commit -m "feat(flowlet-shell): FlowletThread core surface"
```

---

## Task 14: FlowletOverlay element

**Files:**
- Create: `packages/flowlet-shell/src/elements/FlowletOverlay.tsx`
- Test: `packages/flowlet-shell/src/elements/overlay.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/elements/overlay.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { FlowletOverlay } from "./FlowletOverlay";

function setup() {
  return render(
    <FlowletProvider agent={createStubAgent()} components={[]}>
      <FlowletShellProvider>
        <FlowletOverlay launcherLabel="Ask Maple" />
      </FlowletShellProvider>
    </FlowletProvider>,
  );
}

describe("FlowletOverlay", () => {
  it("opens from the launcher and closes on Escape", async () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Ask Maple"));
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test overlay`
Expected: FAIL ("Cannot find module './FlowletOverlay'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/elements/FlowletOverlay.tsx`:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FlowletThread, type FlowletThreadProps } from "../FlowletThread";

export interface FlowletOverlayProps extends FlowletThreadProps {
  launcherLabel?: string;
  /** Open with this keyboard shortcut key (with meta/ctrl). Default "k". */
  shortcutKey?: string;
}

export function FlowletOverlay({ launcherLabel = "Ask", shortcutKey = "k", ...thread }: FlowletOverlayProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === shortcutKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutKey]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="fl-launcher" onClick={() => setOpen(true)}>{launcherLabel}</button>
    );
  }

  return (
    <>
      <div className="fl-overlay-scrim" onClick={() => setOpen(false)} />
      <div
        className="fl-overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-label={launcherLabel}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <FlowletThread {...thread} />
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test overlay`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/elements/FlowletOverlay.tsx packages/flowlet-shell/src/elements/overlay.test.tsx
git commit -m "feat(flowlet-shell): FlowletOverlay element"
```

---

## Task 15: FlowletSlot element

**Files:**
- Create: `packages/flowlet-shell/src/elements/FlowletSlot.tsx`
- Test: `packages/flowlet-shell/src/elements/slot.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/elements/slot.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent, type UINode } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { FlowletSlot } from "./FlowletSlot";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

describe("FlowletSlot", () => {
  it("shows the empty state and opens design mode on click", async () => {
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider>
          <FlowletSlot flowletId="slot-1" emptyLabel="Design a flowlet here" />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    fireEvent.click(screen.getByText("Design a flowlet here"));
    await waitFor(() => screen.getByRole("dialog"));
  });

  it("renders a saved node when one is provided", () => {
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered" />}>
          <FlowletSlot flowletId="slot-1" savedNode={node} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(screen.getByTestId("rendered")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test slot`
Expected: FAIL ("Cannot find module './FlowletSlot'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/elements/FlowletSlot.tsx`:

```tsx
import { useState } from "react";
import type { UINode } from "@flowlet/core";
import { UINodeView } from "../components/UINodeView";
import { FlowletThread } from "../FlowletThread";

export interface FlowletSlotProps {
  flowletId: string;
  savedNode?: UINode;
  emptyLabel?: string;
}

export function FlowletSlot({ flowletId, savedNode, emptyLabel = "Design a flowlet here" }: FlowletSlotProps) {
  const [designing, setDesigning] = useState(false);

  return (
    <div className="fl-slot" data-flowlet-id={flowletId}>
      {savedNode ? (
        <UINodeView node={savedNode} />
      ) : (
        <button type="button" className="fl-slot-empty" onClick={() => setDesigning(true)}>
          <span aria-hidden="true">✦</span>
          <span>{emptyLabel}</span>
        </button>
      )}
      {designing && (
        <>
          <div className="fl-overlay-scrim" onClick={() => setDesigning(false)} />
          <div
            className="fl-overlay-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Design flowlet"
            tabIndex={-1}
            onKeyDown={(e) => { if (e.key === "Escape") setDesigning(false); }}
          >
            <FlowletThread greeting="What should this flowlet show?" />
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test slot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/elements/FlowletSlot.tsx packages/flowlet-shell/src/elements/slot.test.tsx
git commit -m "feat(flowlet-shell): FlowletSlot element"
```

---

## Task 16: FlowletPage element (tabbed)

**Files:**
- Create: `packages/flowlet-shell/src/elements/FlowletPage.tsx`
- Test: `packages/flowlet-shell/src/elements/page.test.tsx`

Note: each tab mounts its own `<FlowletProvider>` + `<FlowletShellProvider>` so conversations are isolated; shared `store`/`integrations`/`impls`/`theme` are passed through. The host gives the page an `agent` and `components`.

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/elements/page.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core";
import { FlowletPage } from "./FlowletPage";

function setup() {
  return render(
    <FlowletPage agent={createStubAgent()} components={[]} greeting="What do you want to build?" />,
  );
}

describe("FlowletPage", () => {
  it("opens with one tab and adds a new tab", () => {
    setup();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("New tab"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("shows the greeting in the active empty tab", () => {
    setup();
    expect(screen.getByText("What do you want to build?")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test page`
Expected: FAIL ("Cannot find module './FlowletPage'").

- [ ] **Step 3: Write the implementation**

`packages/flowlet-shell/src/elements/FlowletPage.tsx`:

```tsx
import { useState, type ComponentType } from "react";
import type { FlowletAgent, RegisteredComponent } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import type { FlowletStore } from "../seams/store";
import type { FlowletIntegrations } from "../seams/integrations";
import type { FlowletTheme } from "../theme";
import { FlowletThread } from "../FlowletThread";

export interface FlowletPageProps {
  agent: FlowletAgent;
  components: RegisteredComponent[];
  store?: FlowletStore;
  integrations?: FlowletIntegrations;
  impls?: Record<string, ComponentType<Record<string, unknown>>>;
  theme?: FlowletTheme;
  greeting?: string;
  suggestions?: string[];
}

interface Tab { id: string; title: string; }

let tabSeq = 0;
const newTab = (): Tab => ({ id: `tab-${++tabSeq}`, title: "New flowlet" });

export function FlowletPage(props: FlowletPageProps) {
  const { agent, components, store, integrations, impls, theme, greeting, suggestions } = props;
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);

  const addTab = () => {
    const tab = newTab();
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
  };

  return (
    <div className="fl-page">
      <div className="fl-tabbar" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            className="fl-tab"
            onClick={() => setActiveId(tab.id)}
          >
            {tab.title}
          </button>
        ))}
        <button type="button" className="fl-tab" aria-label="New tab" onClick={addTab}>＋</button>
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} hidden={tab.id !== activeId} style={{ flex: 1, minHeight: 0 }}>
          <FlowletProvider agent={agent} components={components}>
            <FlowletShellProvider store={store} integrations={integrations} impls={impls} theme={theme}>
              <FlowletThread greeting={greeting} suggestions={suggestions} />
            </FlowletShellProvider>
          </FlowletProvider>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/shell test page`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/elements/FlowletPage.tsx packages/flowlet-shell/src/elements/page.test.tsx
git commit -m "feat(flowlet-shell): FlowletPage tabbed element"
```

---

## Task 17: Public exports + final verification

**Files:**
- Modify: `packages/flowlet-shell/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/flowlet-shell/src/exports.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as shell from "./index";

describe("public API", () => {
  it("exports elements, core, primitives, hooks, and seams", () => {
    const names = [
      "FlowletPage", "FlowletOverlay", "FlowletSlot", "FlowletThread",
      "FlowletShellProvider", "useShell", "useFlowletThread", "toThreadItems",
      "MessageList", "Composer", "ApprovalCard", "UINodeView", "Landing",
      "SuggestionChips", "FlowGallery", "IntegrationsRail", "IntegrationsPicker",
      "ConnectCard", "StreamingText", "ToolCall", "VoiceButton",
      "themeToStyle", "createLocalStore", "createLocalIntegrations", "useVoiceInput",
    ];
    for (const name of names) expect(shell).toHaveProperty(name);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/shell test exports`
Expected: FAIL (missing exports).

- [ ] **Step 3: Write the barrel**

`packages/flowlet-shell/src/index.ts`:

```ts
import "./styles.css";

export const SHELL_PACKAGE = "@flowlet/shell";

export * from "./theme";
export * from "./context";
export * from "./use-flowlet-thread";
export * from "./use-voice-input";
export * from "./seams/store";
export * from "./seams/integrations";

export * from "./components/StreamingText";
export * from "./components/ToolCall";
export * from "./components/ApprovalCard";
export * from "./components/UINodeView";
export * from "./components/VoiceButton";
export * from "./components/Composer";
export * from "./components/MessageList";
export * from "./components/SuggestionChips";
export * from "./components/FlowGallery";
export * from "./components/Landing";
export * from "./components/IntegrationsRail";
export * from "./components/IntegrationsPicker";
export * from "./components/ConnectCard";

export * from "./FlowletThread";
export * from "./elements/FlowletOverlay";
export * from "./elements/FlowletSlot";
export * from "./elements/FlowletPage";
```

- [ ] **Step 4: Run the full suite, typecheck, and build**

Run: `pnpm --filter @flowlet/shell test`
Expected: all tests pass.
Run: `pnpm --filter @flowlet/shell typecheck`
Expected: no type errors.
Run: `pnpm --filter @flowlet/shell build`
Expected: emits `dist/` with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-shell/src/index.ts packages/flowlet-shell/src/exports.test.ts
git commit -m "feat(flowlet-shell): public API barrel + full verification"
```

---

## Self-review notes

- **Spec coverage:** package isolation (Task 1), INK/LIFT tokens + theming (Tasks 1-2, styles.css), three elements (Tasks 14-16), shared core + primitives + view-model (Tasks 6-13), FlowletStore + FlowletIntegrations + renderer seams (Tasks 3-5), integrations in chat (Tasks 12-13), data flow + HITL (Task 13), voice stub (Task 9), errors/cancellation via stop (Task 9 + 13), a11y roles/keyboard/focus (Tasks 10, 14-16), testing throughout. Auto light/dark lives in `styles.css` `light-dark()` defaults plus `themeToStyle` scheme.
- **Deferred (matches spec non-goals):** real sandbox renderer, real LLM/Composio, real Flowlet-backed persistence, sharing/cron, real voice capture. The connect-to-continue card is shipped as a primitive (Task 12); auto-surfacing it from the stream is deferred since the stub does not emit connect requests.
- **Type consistency:** `ThreadItem`, `Flowlet`/`FlowletStore`, `Integration`/`FlowletIntegrations`, `RenderNode`, `FlowletTheme`, and `FlowletThreadProps` are defined once and reused across tasks. Component prop names match their tests.
```

## Post-execution: review findings + follow-ups

Executed subagent-driven (19 tasks incl. visual verification + final review). All committed; 43 tests pass, typecheck + monorepo build clean. Final review fixes applied:

- Page chrome now wrapped in `.flowlet-root` so the tab bar gets theme tokens.
- `color-scheme: light dark` on `.flowlet-root` so `light-dark()` follows the OS by default.
- `SuggestionChips` keys include index (no collision on duplicate text).
- `styles.css` shipped into `dist/` by the build; subpath export points to `dist`.
- Focus trap + restore for the overlay/slot dialogs (`useFocusTrap`).
- Error stream parts render inline (`.fl-error`, `role="alert"`); composer-level error notice on `status === "error"`.

**Deferred follow-ups (tracked, not built in F5):**

1. **FlowletStore persistence loop.** The store is a wired seam with a local impl, but nothing calls `save`/`load` yet. Deferred because the real Flowlet-backed store (sharing, cron) is F6/F7 and a local-only loop risks rework. When picked up: slot design→`store.save`→render-in-place; slot hover toolbar (edit/refresh/open-in-page); Landing gallery populated from `store.list`; tab/slot persistence; overlay "Open in page" promotion.
2. **Overlay launcher focus restore.** The launcher unmounts while open, so focus is not restored to it on close (only restored when the trigger node stays connected). Minor; revisit if it matters.
3. **Connect-to-continue auto-surfacing.** `ConnectCard` exists as a primitive but isn't auto-surfaced from the stream (the stub emits no connect requests); wire when F2's real agent emits them.
