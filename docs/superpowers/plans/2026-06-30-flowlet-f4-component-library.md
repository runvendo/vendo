# F4 · Pre-wired Component Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@flowlet/components` — a starter set of ~15 OpenUI (Crayon)-backed components wrapped into the F1 registry contract, themeable to a host brand, verified via F1's stub renderer.

**Architecture:** A new package owns the `@openuidev/react-ui` dependency. Each component is a pair: a React-free **descriptor** (`name`, `description`, Zod `propsSchema`) and a React **impl** (a wrapper that validates JSON props and renders OpenUI components). Two barrels expose them as separate entrypoints (`/descriptors` is React-free; the root carries impls + theming). `prewiredComponents` (the LLM menu) and `prewiredImpls` (the render map) derive mechanically from the pairs so they cannot drift.

**Tech Stack:** TypeScript, React 18, Zod (Standard Schema), `@openuidev/react-ui` v0.12.x (MIT, Radix + Recharts + react-markdown), Vitest + @testing-library/react + jsdom, pnpm workspaces + turbo.

**Spec:** `docs/superpowers/specs/2026-06-30-flowlet-f4-component-library-design.md`

**Key facts pinned during planning:**
- Package: `@openuidev/react-ui` (Crayon rebranded to OpenUI; `@crayonai/react-ui` is the frozen old name). All components export from the package root. Base CSS: `@openuidev/react-ui/index.css`.
- `ThemeProvider` props: `{ mode?: "light"|"dark"; lightTheme?: Theme; darkTheme?: Theme; theme?: Theme (deprecated); cssSelector?: string }`. Prefer `lightTheme`/`darkTheme` + `mode`, not the deprecated `theme`.
- `Theme` is a flat object of optional string fields across color/layout/typography/effects. Fields we map: `background`, `elevated`, `sunk`, `textNeutralPrimary`, `textNeutralSecondary`, `textBrand`, `interactiveAccentDefault`, `borderAccent`, `fontBody`/`fontHeading`/`fontLabel`/`fontNumbers`/`fontCode`, `radiusM` (+ scale).
- `Card` props: `{ variant?: "clear"|"card"|"sunk"; width?: "standard"|"full" } & div attrs`; renders `children`. `CardHeader` props: `{ icon?: ReactNode; title?: ReactNode; subtitle?: ReactNode; actions?; className?; styles? }`.
- F1 contract (do not modify): `RegisteredComponent { name, description, propsSchema, source }`, `ComponentNode { id, kind, source, name, props, children? }`, `StubRenderer({ node, impls })` spreads `node.props` into `impls[node.name]` and **drops `children`**.

---

## File Structure

```
packages/flowlet-components/
  package.json                         # @flowlet/components; deps: @openuidev/react-ui, @flowlet/core, zod; peer react
  tsconfig.json
  vitest.config.ts
  vitest.setup.ts                      # jsdom + @testing-library/jest-dom
  src/
    descriptor.ts                      # PrewiredDescriptor type + prewired() helper + JsonValue zod schema
    descriptors.ts                     # React-free barrel: imports each components/*/descriptor.ts; exports `descriptors` + `prewiredComponents`
    theme/
      brand.ts                         # BrandTokens type + zod schema (versioned) + defaultBrand
      map-brand-to-theme.ts            # mapBrandToTheme(brand) -> OpenUI Theme
      FlowletThemeProvider.tsx         # wraps OpenUI ThemeProvider
    impl-helpers/
      create-impl.tsx                  # createPrewiredImpl(schema, render) with validation + fallback
      safe-url.ts                      # allowlistUrl(url): string | undefined
      icon.ts                          # resolveIcon(name): ReactNode (lucide-react)
    components/
      Card/        { descriptor.ts, impl.tsx }
      Table/       { descriptor.ts, impl.tsx }
      Chart/       { descriptor.ts, impl.tsx }
      Form/        { descriptor.ts, impl.tsx }
      Accordion/   { descriptor.ts, impl.tsx }
      Carousel/    { descriptor.ts, impl.tsx }
      Callout/     { descriptor.ts, impl.tsx }
      Tags/        { descriptor.ts, impl.tsx }
      Steps/       { descriptor.ts, impl.tsx }
      List/        { descriptor.ts, impl.tsx }
      Image/       { descriptor.ts, impl.tsx }
      ImageGallery/{ descriptor.ts, impl.tsx }
      Markdown/    { descriptor.ts, impl.tsx }
      CodeBlock/   { descriptor.ts, impl.tsx }
      Tabs/        { descriptor.ts, impl.tsx }
    impls.ts                           # barrel: imports each components/*/impl.tsx; exports `prewiredImpls`
    index.ts                           # re-exports descriptors, prewiredComponents, prewiredImpls, theming, types
    __tests__/
      contract.test.ts                 # correspondence, uniqueness, JSON round-trip, JSON-schema, react-free descriptors
examples/components/                   # new example page (mirrors examples/basic)
  package.json, tsconfig.json, vite.config.ts, index.html, src/{main.tsx,App.tsx}
```

**Per-component convention:** `components/<Name>/descriptor.ts` exports `<name>Descriptor: PrewiredDescriptor` (React-free: Zod schema + description). `components/<Name>/impl.tsx` imports that descriptor's schema and exports `<Name>` (the validated wrapper). Adding a component = add its folder + register in both barrels.

---

## Task 1: Scaffold the `@flowlet/components` package

**Files:**
- Create: `packages/flowlet-components/package.json`
- Create: `packages/flowlet-components/tsconfig.json`
- Create: `packages/flowlet-components/vitest.config.ts`
- Create: `packages/flowlet-components/vitest.setup.ts`
- Create: `packages/flowlet-components/src/index.ts` (temporary placeholder)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@flowlet/components",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./descriptors": { "types": "./dist/descriptors.d.ts", "default": "./dist/descriptors.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": { "react": "^18.0.0", "react-dom": "^18.0.0" },
  "dependencies": {
    "@flowlet/core": "workspace:*",
    "@openuidev/react-ui": "^0.12.1",
    "lucide-react": "^0.562.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.0",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "jsdom": "^25.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (mirror `packages/flowlet-react/tsconfig.json`)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules", "**/*.test.ts", "**/*.test.tsx"]
}
```

(Confirm field names against `packages/flowlet-react/tsconfig.json` and align `tsconfig.base.json` extends path. If flowlet-react sets `types`/`skipLibCheck`, match it.)

- [ ] **Step 3: Create `vitest.config.ts`** (mirror flowlet-react)

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
```

- [ ] **Step 4: Create `vitest.setup.ts`**

```ts
import "@testing-library/jest-dom";
```

- [ ] **Step 5: Create placeholder `src/index.ts`**

```ts
export const FLOWLET_COMPONENTS_VERSION = "0.0.0";
```

- [ ] **Step 6: Install from the monorepo root**

Run: `pnpm install`
Expected: resolves and links `@openuidev/react-ui`, `lucide-react`, testing libs; `@flowlet/components` appears in the workspace. No peer-dependency errors that block install.

- [ ] **Step 7: Verify typecheck runs**

Run: `pnpm --filter @flowlet/components typecheck`
Expected: PASS (no errors).

- [ ] **Step 8: Commit**

```bash
git add packages/flowlet-components pnpm-lock.yaml
git commit -m "feat(components): scaffold @flowlet/components package"
```

---

## Task 2: Descriptor type + `prewired()` helper + JSON-value boundary

**Files:**
- Create: `packages/flowlet-components/src/descriptor.ts`
- Test: `packages/flowlet-components/src/descriptor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { prewired, jsonValue } from "./descriptor";

describe("prewired()", () => {
  it("builds a descriptor and a RegisteredComponent stamped prewired", () => {
    const d = prewired("Demo", "a demo", z.object({ title: z.string() }));
    expect(d.name).toBe("Demo");
    expect(d.toRegistered().source).toBe("prewired");
    expect(d.toRegistered().name).toBe("Demo");
  });

  it("jsonValue accepts JSON data and rejects non-JSON", () => {
    expect(jsonValue.safeParse({ a: [1, "x", true, null] }).success).toBe(true);
    expect(jsonValue.safeParse(() => 1).success).toBe(false);
    expect(jsonValue.safeParse(new Date()).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/components test descriptor`
Expected: FAIL — `./descriptor` has no `prewired`/`jsonValue`.

- [ ] **Step 3: Write `src/descriptor.ts`**

```ts
import { z } from "zod";
import type { RegisteredComponent, FlowletSchema } from "@flowlet/core";

/** A registered component's metadata. React-free — safe for the descriptors entrypoint. */
export interface PrewiredDescriptor {
  name: string;
  description: string;
  propsSchema: z.ZodType;
  toRegistered(): RegisteredComponent;
}

export function prewired(
  name: string,
  description: string,
  propsSchema: z.ZodType,
): PrewiredDescriptor {
  return {
    name,
    description,
    propsSchema,
    toRegistered: () => ({
      name,
      description,
      propsSchema: propsSchema as FlowletSchema<unknown>,
      source: "prewired",
    }),
  };
}

/** Recursive JSON value — the boundary every prop schema must stay within. */
export const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/components test descriptor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-components/src/descriptor.ts packages/flowlet-components/src/descriptor.test.ts
git commit -m "feat(components): descriptor helper + JSON-value boundary"
```

---

## Task 3: Impl helpers — validation wrapper, URL allowlist, icon resolver

**Files:**
- Create: `packages/flowlet-components/src/impl-helpers/safe-url.ts`
- Create: `packages/flowlet-components/src/impl-helpers/icon.ts`
- Create: `packages/flowlet-components/src/impl-helpers/create-impl.tsx`
- Test: `packages/flowlet-components/src/impl-helpers/helpers.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { z } from "zod";
import { allowlistUrl } from "./safe-url";
import { createPrewiredImpl } from "./create-impl";

describe("allowlistUrl", () => {
  it("passes https and data:image, rejects javascript and data:text/html", () => {
    expect(allowlistUrl("https://x.com/a.png")).toBe("https://x.com/a.png");
    expect(allowlistUrl("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
    expect(allowlistUrl("javascript:alert(1)")).toBeUndefined();
    expect(allowlistUrl("data:text/html,<script>")).toBeUndefined();
  });
});

describe("createPrewiredImpl", () => {
  const Demo = createPrewiredImpl(z.object({ title: z.string() }), (p) => (
    <div data-testid="ok">{p.title}</div>
  ));

  it("renders on valid props", () => {
    render(<Demo title="hi" />);
    expect(screen.getByTestId("ok").textContent).toBe("hi");
  });

  it("renders a fallback (not a throw) on invalid props", () => {
    render(<Demo title={123 as unknown as string} />);
    expect(screen.getByTestId("flowlet-invalid-props")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/components test helpers`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/impl-helpers/safe-url.ts`**

```ts
/** Returns the URL if its protocol is allowlisted, else undefined. */
export function allowlistUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const trimmed = url.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(trimmed)) return trimmed;
  return undefined;
}
```

- [ ] **Step 4: Write `src/impl-helpers/icon.ts`**

```tsx
import type { ReactNode } from "react";
import { icons } from "lucide-react";

/** Resolve a lucide icon by PascalCase name (e.g. "FlaskConical"). Unknown -> null. */
export function resolveIcon(name: unknown, size = "1em"): ReactNode {
  if (typeof name !== "string") return null;
  const Icon = (icons as Record<string, React.ComponentType<{ size?: string | number }>>)[name];
  return Icon ? <Icon size={size} /> : null;
}
```

(If `lucide-react` does not export an `icons` record in the installed version, switch to `import * as Lucide from "lucide-react"` and index `Lucide[name]`. Confirm against installed types in this step.)

- [ ] **Step 5: Write `src/impl-helpers/create-impl.tsx`**

```tsx
import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";

/**
 * Wraps a render fn with schema validation. The agent (and the stub renderer,
 * which spreads raw node.props) can pass malformed props — validate here and
 * render an inline fallback instead of throwing or feeding garbage to OpenUI.
 */
export function createPrewiredImpl<S extends z.ZodType>(
  schema: S,
  renderValid: (props: z.infer<S>) => ReactNode,
): ComponentType<Record<string, unknown>> {
  function Impl(raw: Record<string, unknown>) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return <div data-testid="flowlet-invalid-props">Invalid component props</div>;
    }
    return <>{renderValid(parsed.data)}</>;
  }
  return Impl;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @flowlet/components test helpers`
Expected: PASS (4 assertions).

- [ ] **Step 7: Commit**

```bash
git add packages/flowlet-components/src/impl-helpers
git commit -m "feat(components): impl helpers (validation wrapper, url allowlist, icon resolver)"
```

---

## Task 4: Theming — `BrandTokens`, `mapBrandToTheme`, `FlowletThemeProvider`

**Files:**
- Create: `packages/flowlet-components/src/theme/brand.ts`
- Create: `packages/flowlet-components/src/theme/map-brand-to-theme.ts`
- Create: `packages/flowlet-components/src/theme/FlowletThemeProvider.tsx`
- Test: `packages/flowlet-components/src/theme/theme.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { brandTokensSchema, defaultBrand } from "./brand";
import { mapBrandToTheme } from "./map-brand-to-theme";
import { FlowletThemeProvider } from "./FlowletThemeProvider";

describe("BrandTokens", () => {
  it("defaultBrand is valid and versioned", () => {
    expect(brandTokensSchema.safeParse(defaultBrand).success).toBe(true);
    expect(defaultBrand.version).toBe(1);
  });

  it("rejects a non-literal color reference", () => {
    expect(brandTokensSchema.safeParse({ ...defaultBrand, accent: "var(--x)" }).success).toBe(false);
  });

  it("maps accent/background/text onto OpenUI theme fields", () => {
    const theme = mapBrandToTheme({ ...defaultBrand, accent: "#0A7CFF", background: "#FFFFFF", text: "#111111" });
    expect(theme.interactiveAccentDefault).toBe("#0A7CFF");
    expect(theme.background).toBe("#FFFFFF");
    expect(theme.textNeutralPrimary).toBe("#111111");
  });
});

describe("FlowletThemeProvider", () => {
  it("renders children", () => {
    render(
      <FlowletThemeProvider brand={defaultBrand}>
        <span data-testid="child">x</span>
      </FlowletThemeProvider>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/components test theme`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/theme/brand.ts`**

```ts
import { z } from "zod";

/** A literal hex color (#rgb / #rrggbb / #rrggbbaa). No var()/url() references. */
const hexColor = z.string().regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

/**
 * Serializable, versioned host-brand tokens. Fully resolved primitives only —
 * literal colors, a literal font-stack string, a numeric radius (px). The F3
 * sandbox has no host CSS vars or loaded fonts (see spec §6).
 */
export const brandTokensSchema = z.object({
  version: z.literal(1),
  accent: hexColor,
  background: hexColor,
  surface: hexColor,
  text: hexColor,
  mutedText: hexColor,
  fontFamily: z.string().min(1),
  radius: z.number().nonnegative(),
  mode: z.enum(["light", "dark"]).optional(),
});

export type BrandTokens = z.infer<typeof brandTokensSchema>;

export const defaultBrand: BrandTokens = {
  version: 1,
  accent: "#0A7CFF",
  background: "#FFFFFF",
  surface: "#F5F7FA",
  text: "#111418",
  mutedText: "#5B6470",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  radius: 8,
  mode: "light",
};
```

- [ ] **Step 4: Write `src/theme/map-brand-to-theme.ts`**

```ts
import type { Theme } from "@openuidev/react-ui";
import type { BrandTokens } from "./brand";

/** Map Flowlet brand tokens onto the OpenUI Theme object (flat string fields). */
export function mapBrandToTheme(brand: BrandTokens): Theme {
  const radius = `${brand.radius}px`;
  return {
    // surfaces
    background: brand.background,
    elevated: brand.surface,
    sunk: brand.surface,
    popoverBackground: brand.surface,
    // text
    textNeutralPrimary: brand.text,
    textNeutralSecondary: brand.mutedText,
    textNeutralTertiary: brand.mutedText,
    // accent / brand
    textBrand: brand.accent,
    textAccentPrimary: brand.accent,
    interactiveAccentDefault: brand.accent,
    interactiveAccentHover: brand.accent,
    interactiveAccentPressed: brand.accent,
    borderAccent: brand.accent,
    // typography
    fontBody: brand.fontFamily,
    fontHeading: brand.fontFamily,
    fontLabel: brand.fontFamily,
    fontNumbers: brand.fontFamily,
    // radius scale (apply the single brand radius across the common steps)
    radiusS: radius,
    radiusM: radius,
    radiusL: radius,
  };
}
```

(If `Theme` is not exported from the package root, import from `@openuidev/react-ui/ThemeProvider`. Confirm the exact export + that these field names exist on `Theme` against the installed `.d.ts` in this step — they were verified against source during planning.)

- [ ] **Step 5: Write `src/theme/FlowletThemeProvider.tsx`**

```tsx
import type { ReactNode } from "react";
import { ThemeProvider } from "@openuidev/react-ui";
import { type BrandTokens, defaultBrand } from "./brand";
import { mapBrandToTheme } from "./map-brand-to-theme";

export interface FlowletThemeProviderProps {
  brand?: BrandTokens;
  children: ReactNode;
}

/** Wraps OpenUI's ThemeProvider, mapping host brand tokens to its Theme. */
export function FlowletThemeProvider({ brand = defaultBrand, children }: FlowletThemeProviderProps) {
  const theme = mapBrandToTheme(brand);
  const mode = brand.mode ?? "light";
  return (
    <ThemeProvider mode={mode} lightTheme={theme} darkTheme={theme}>
      {children}
    </ThemeProvider>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @flowlet/components test theme`
Expected: PASS (4 assertions).

- [ ] **Step 7: Commit**

```bash
git add packages/flowlet-components/src/theme
git commit -m "feat(components): brand tokens + OpenUI theme mapping + FlowletThemeProvider"
```

---

## Task 5: Card (the fully-worked wrapper pattern)

**Files:**
- Create: `packages/flowlet-components/src/components/Card/descriptor.ts`
- Create: `packages/flowlet-components/src/components/Card/impl.tsx`
- Test: `packages/flowlet-components/src/components/Card/Card.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { cardDescriptor } from "./descriptor";
import { Card } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("Card", () => {
  it("schema accepts a valid card and rejects a missing title", () => {
    expect(cardDescriptor.propsSchema.safeParse({ title: "Hi" }).success).toBe(true);
    expect(cardDescriptor.propsSchema.safeParse({}).success).toBe(false);
  });

  it("renders title, body and tags", () => {
    renderThemed(<Card title="Account" body="Balance is healthy" tags={["active", "verified"]} />);
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Balance is healthy")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/components test Card`
Expected: FAIL — `./descriptor` / `./impl` not found.

- [ ] **Step 3: Write `src/components/Card/descriptor.ts`**

```ts
import { z } from "zod";
import { prewired } from "../../descriptor";

export const cardSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  iconName: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const cardDescriptor = prewired(
  "Card",
  "A titled content card with optional subtitle, icon, body text, and tags. Use to present a single record, summary, or labeled block of information.",
  cardSchema,
);
```

- [ ] **Step 4: Write `src/components/Card/impl.tsx`**

```tsx
import { Card as UICard, CardHeader, Tag, TagBlock } from "@openuidev/react-ui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { resolveIcon } from "../../impl-helpers/icon";
import { cardSchema } from "./descriptor";

export const Card = createPrewiredImpl(cardSchema, (p) => (
  <UICard variant="card" width="standard">
    <CardHeader
      title={<span>{p.title}</span>}
      subtitle={p.subtitle ? <span>{p.subtitle}</span> : undefined}
      icon={resolveIcon(p.iconName)}
    />
    {p.body ? <p>{p.body}</p> : null}
    {p.tags && p.tags.length > 0 ? (
      <TagBlock>
        {p.tags.map((t) => (
          <Tag key={t} text={<span>{t}</span>} />
        ))}
      </TagBlock>
    ) : null}
  </UICard>
));
```

(Confirm `Tag`'s prop is `text` and `TagBlock` wraps tags against installed types; planning verified `CardHeader` uses `title`/`subtitle`/`icon` ReactNode props. If `Tag` uses `label`/children instead, adjust — the test asserts the rendered text, so it will catch a wrong prop.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowlet/components test Card`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-components/src/components/Card
git commit -m "feat(components): Card wrapper"
```

---

## Task 6: Table

**Files:**
- Create: `packages/flowlet-components/src/components/Table/descriptor.ts`
- Create: `packages/flowlet-components/src/components/Table/impl.tsx`
- Test: `packages/flowlet-components/src/components/Table/Table.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { tableDescriptor } from "./descriptor";
import { Table } from "./impl";

describe("Table", () => {
  it("schema requires columns and rows", () => {
    expect(tableDescriptor.propsSchema.safeParse({ columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }).success).toBe(true);
    expect(tableDescriptor.propsSchema.safeParse({ columns: [] }).success).toBe(false);
  });

  it("renders headers and cell values", () => {
    render(
      <FlowletThemeProvider>
        <Table
          columns={[{ key: "name", label: "Name" }, { key: "amt", label: "Amount" }]}
          rows={[{ name: "Alice", amt: 42 }]}
        />
      </FlowletThemeProvider>,
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/components test Table`
Expected: FAIL.

- [ ] **Step 3: Write `src/components/Table/descriptor.ts`**

```ts
import { z } from "zod";
import { prewired } from "../../descriptor";

export const tableSchema = z.object({
  caption: z.string().optional(),
  columns: z.array(z.object({ key: z.string(), label: z.string() })).min(1),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
});

export const tableDescriptor = prewired(
  "Table",
  "A data table with labeled columns and rows of records. Use to list structured rows such as transactions, items, or comparisons.",
  tableSchema,
);
```

- [ ] **Step 4: Write `src/components/Table/impl.tsx`**

Render with OpenUI's `Table` family. Confirm the exact sub-component API from installed types (likely `Table`, `TableHead`, `TableBody`, `TableRow`, `TableCell` or a data-driven `columns`/`data` prop). Use this structure, adjusting names to the real exports:

```tsx
import { Table as UITable, TableHead, TableHeaderRow, TableHeaderCell, TableBody, TableRow, TableCell } from "@openuidev/react-ui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { tableSchema } from "./descriptor";

export const Table = createPrewiredImpl(tableSchema, (p) => (
  <UITable>
    <TableHead>
      <TableHeaderRow>
        {p.columns.map((c) => (
          <TableHeaderCell key={c.key}>{c.label}</TableHeaderCell>
        ))}
      </TableHeaderRow>
    </TableHead>
    <TableBody>
      {p.rows.map((row, i) => (
        <TableRow key={i}>
          {p.columns.map((c) => (
            <TableCell key={c.key}>{String(row[c.key] ?? "")}</TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  </UITable>
));
```

If OpenUI's Table is data-driven (takes `columns`/`data` props rather than composed sub-rows), map to that API instead; the test asserts rendered header + cell text and will fail on a wrong mapping.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowlet/components test Table`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-components/src/components/Table
git commit -m "feat(components): Table wrapper"
```

---

## Task 7: Chart

**Files:**
- Create: `packages/flowlet-components/src/components/Chart/descriptor.ts`
- Create: `packages/flowlet-components/src/components/Chart/impl.tsx`
- Test: `packages/flowlet-components/src/components/Chart/Chart.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { chartDescriptor } from "./descriptor";
import { Chart } from "./impl";

describe("Chart", () => {
  it("schema accepts a valid bar chart and rejects an unknown kind", () => {
    const ok = { kind: "bar", categoryKey: "month", series: ["sales"], data: [{ month: "Jan", sales: 10 }] };
    expect(chartDescriptor.propsSchema.safeParse(ok).success).toBe(true);
    expect(chartDescriptor.propsSchema.safeParse({ ...ok, kind: "pie3d" }).success).toBe(false);
  });

  it("renders without throwing for each kind", () => {
    const data = [{ month: "Jan", sales: 10 }, { month: "Feb", sales: 20 }];
    for (const kind of ["bar", "line", "area", "pie"] as const) {
      const { unmount } = render(
        <FlowletThemeProvider>
          <Chart kind={kind} categoryKey="month" series={["sales"]} data={data} />
        </FlowletThemeProvider>,
      );
      unmount();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/components test Chart`
Expected: FAIL.

- [ ] **Step 3: Write `src/components/Chart/descriptor.ts`**

```ts
import { z } from "zod";
import { prewired } from "../../descriptor";

export const chartSchema = z.object({
  kind: z.enum(["bar", "line", "area", "pie"]),
  title: z.string().optional(),
  categoryKey: z.string(),
  series: z.array(z.string()).min(1),
  data: z.array(z.record(z.union([z.string(), z.number()]))),
});

export const chartDescriptor = prewired(
  "Chart",
  "A chart (bar, line, area, or pie) over a list of data points. `categoryKey` is the x-axis/label field; `series` lists the numeric value fields to plot. Use to visualize trends, comparisons, or distributions.",
  chartSchema,
);
```

- [ ] **Step 4: Write `src/components/Chart/impl.tsx`**

OpenUI exposes chart components (backed by Recharts) from the package root (`export * from "./components/Charts"`). Confirm the exact component names + props from installed types (likely `BarChart`, `LineChart`, `AreaChart`, `PieChart` with `data`, `categoryKey`/`index`, and a series/`dataKey` prop). Map `kind` to the component:

```tsx
import { BarChart, LineChart, AreaChart, PieChart } from "@openuidev/react-ui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { chartSchema } from "./descriptor";

export const Chart = createPrewiredImpl(chartSchema, (p) => {
  const common = { data: p.data, categoryKey: p.categoryKey };
  if (p.kind === "line") return <LineChart {...common} dataKeys={p.series} />;
  if (p.kind === "area") return <AreaChart {...common} dataKeys={p.series} />;
  if (p.kind === "pie") return <PieChart data={p.data} categoryKey={p.categoryKey} dataKey={p.series[0]} />;
  return <BarChart {...common} dataKeys={p.series} />;
});
```

Adjust prop names (`dataKeys` vs `categoricalBarChartData` etc.) to the real OpenUI chart API confirmed from installed types. The test only asserts each kind renders without throwing, so it tolerates styling differences but catches a wrong import/prop that errors.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowlet/components test Chart`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-components/src/components/Chart
git commit -m "feat(components): Chart wrapper"
```

---

## Task 8: Form (inert; fields[] discriminated union)

**Files:**
- Create: `packages/flowlet-components/src/components/Form/descriptor.ts`
- Create: `packages/flowlet-components/src/components/Form/impl.tsx`
- Test: `packages/flowlet-components/src/components/Form/Form.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { formDescriptor } from "./descriptor";
import { Form } from "./impl";

describe("Form", () => {
  it("schema accepts a multi-field form, rejects an unknown field type", () => {
    const ok = { submitLabel: "Save", fields: [
      { type: "text", name: "name", label: "Name" },
      { type: "select", name: "plan", label: "Plan", options: [{ value: "a", label: "A" }] },
    ]};
    expect(formDescriptor.propsSchema.safeParse(ok).success).toBe(true);
    expect(formDescriptor.propsSchema.safeParse({ submitLabel: "x", fields: [{ type: "wormhole", name: "n", label: "L" }] }).success).toBe(false);
  });

  it("renders field labels and a disabled submit (inert in F4)", () => {
    render(
      <FlowletThemeProvider>
        <Form submitLabel="Save" fields={[{ type: "text", name: "name", label: "Full name" }]} />
      </FlowletThemeProvider>,
    );
    expect(screen.getByText("Full name")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Save" });
    expect(submit).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/components test Form`
Expected: FAIL.

- [ ] **Step 3: Write `src/components/Form/descriptor.ts`**

```ts
import { z } from "zod";
import { prewired } from "../../descriptor";

const option = z.object({ value: z.string(), label: z.string() });
const base = { name: z.string(), label: z.string(), required: z.boolean().optional(), placeholder: z.string().optional() };

export const formFieldSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), ...base }),
  z.object({ type: z.literal("number"), ...base }),
  z.object({ type: z.literal("textarea"), ...base }),
  z.object({ type: z.literal("select"), ...base, options: z.array(option) }),
  z.object({ type: z.literal("checkbox"), ...base }),
  z.object({ type: z.literal("radio"), ...base, options: z.array(option) }),
  z.object({ type: z.literal("switch"), ...base }),
  z.object({ type: z.literal("toggle"), ...base, options: z.array(option) }),
  z.object({ type: z.literal("slider"), ...base, min: z.number().optional(), max: z.number().optional() }),
  z.object({ type: z.literal("date"), ...base }),
]);

export const formSchema = z.object({
  title: z.string().optional(),
  submitLabel: z.string(),
  fields: z.array(formFieldSchema).min(1),
});

export const formDescriptor = prewired(
  "Form",
  "A form describing input fields (text, number, textarea, select, checkbox, radio, switch, toggle, slider, date). Renders the inputs for display; submission is not wired in this version. Use to lay out data the user would enter.",
  formSchema,
);
```

- [ ] **Step 4: Write `src/components/Form/impl.tsx`**

Render each field with the matching OpenUI input (`Input`, `TextArea`, `Select`, `CheckBoxItem`, `RadioGroup`, `SwitchItem`, `ToggleGroup`, `Slider`, `DatePicker`) inside `FormControl` + `Label`. Confirm each input's props from installed types. Submit is a plain disabled button (no callback — inert per spec §5).

```tsx
import { FormControl, Label, Input, TextArea, Select, Slider } from "@openuidev/react-ui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { formSchema } from "./descriptor";

export const Form = createPrewiredImpl(formSchema, (p) => (
  <form onSubmit={(e) => e.preventDefault()}>
    {p.title ? <h3>{p.title}</h3> : null}
    {p.fields.map((f) => (
      <FormControl key={f.name}>
        <Label>{f.label}</Label>
        {f.type === "textarea" ? (
          <TextArea name={f.name} placeholder={f.placeholder} />
        ) : f.type === "select" ? (
          <Select options={f.options} />
        ) : f.type === "slider" ? (
          <Slider min={f.min} max={f.max} />
        ) : f.type === "number" ? (
          <Input name={f.name} type="number" placeholder={f.placeholder} />
        ) : (
          <Input name={f.name} placeholder={f.placeholder} />
        )}
      </FormControl>
    ))}
    <button type="submit" disabled>
      {p.submitLabel}
    </button>
  </form>
));
```

For checkbox/radio/switch/toggle/date, render the matching OpenUI component; if a given input's props differ, adjust. The test asserts a field label renders and the submit button is disabled — keep the submit `disabled` with no `onClick`/`onSubmit` side effect (the `<form>`'s `onSubmit` only `preventDefault`s).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowlet/components test Form`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-components/src/components/Form
git commit -m "feat(components): inert Form wrapper with fields union"
```

---

## Task 9: Barrels + package exports

**Files:**
- Create: `packages/flowlet-components/src/descriptors.ts`
- Create: `packages/flowlet-components/src/impls.ts`
- Modify: `packages/flowlet-components/src/index.ts`

- [ ] **Step 1: Write `src/descriptors.ts` (React-free barrel)**

```ts
import type { RegisteredComponent } from "@flowlet/core";
import type { PrewiredDescriptor } from "./descriptor";
import { cardDescriptor } from "./components/Card/descriptor";
import { tableDescriptor } from "./components/Table/descriptor";
import { chartDescriptor } from "./components/Chart/descriptor";
import { formDescriptor } from "./components/Form/descriptor";

export const descriptors: PrewiredDescriptor[] = [
  cardDescriptor,
  tableDescriptor,
  chartDescriptor,
  formDescriptor,
];

export const prewiredComponents: RegisteredComponent[] = descriptors.map((d) => d.toRegistered());
```

(Add each new descriptor import here as components are built in Tasks 11–12.)

- [ ] **Step 2: Write `src/impls.ts` (React barrel)**

```ts
import type { ComponentType } from "react";
import { Card } from "./components/Card/impl";
import { Table } from "./components/Table/impl";
import { Chart } from "./components/Chart/impl";
import { Form } from "./components/Form/impl";

export const prewiredImpls: Record<string, ComponentType<Record<string, unknown>>> = {
  Card,
  Table,
  Chart,
  Form,
};
```

(Add each new impl here as components are built.)

- [ ] **Step 3: Rewrite `src/index.ts`**

```ts
export { descriptors, prewiredComponents } from "./descriptors";
export { prewiredImpls } from "./impls";
export type { PrewiredDescriptor } from "./descriptor";
export { FlowletThemeProvider } from "./theme/FlowletThemeProvider";
export { brandTokensSchema, defaultBrand, type BrandTokens } from "./theme/brand";
export { mapBrandToTheme } from "./theme/map-brand-to-theme";
import "@openuidev/react-ui/index.css";
```

(The CSS side-effect import lives in the impls/root entrypoint, never in `descriptors.ts`. Confirm the CSS path `@openuidev/react-ui/index.css` resolves; the package exports map includes `./index.css`.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @flowlet/components typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-components/src/descriptors.ts packages/flowlet-components/src/impls.ts packages/flowlet-components/src/index.ts
git commit -m "feat(components): descriptor/impl barrels + package exports"
```

---

## Task 10: Contract tests (correspondence, uniqueness, JSON boundary, React-free descriptors)

**Files:**
- Create: `packages/flowlet-components/src/__tests__/contract.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { descriptors, prewiredComponents } from "../descriptors";
import { prewiredImpls } from "../impls";

describe("prewired contract", () => {
  it("every descriptor has exactly one impl and vice versa", () => {
    const descNames = descriptors.map((d) => d.name).sort();
    const implNames = Object.keys(prewiredImpls).sort();
    expect(implNames).toEqual(descNames);
  });

  it("all descriptors are stamped source=prewired", () => {
    expect(prewiredComponents.every((c) => c.source === "prewired")).toBe(true);
  });

  it("prewired names are globally unique", () => {
    const names = descriptors.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every props schema is JSON-round-trippable and JSON-Schema convertible", () => {
    for (const d of descriptors) {
      expect(() => zodToJsonSchema(d.propsSchema as never)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Add the dev dependency**

Run: `pnpm --filter @flowlet/components add -D zod-to-json-schema`
Expected: installs; lockfile updates.

- [ ] **Step 3: Run test to verify it fails (then passes)**

Run: `pnpm --filter @flowlet/components test contract`
Expected: PASS (the four tasks above already satisfy correspondence with 4 components). If the names array test fails, fix the barrel that is out of sync.

- [ ] **Step 4: Add the React-free descriptors guard test**

Append to the same file:

```ts
it("the descriptors entrypoint pulls in no React/Crayon", async () => {
  const mod = await import("../descriptors");
  // A smoke check that importing descriptors does not require a DOM/React runtime.
  expect(Array.isArray(mod.descriptors)).toBe(true);
});
```

(For a stronger guarantee, Task 14 adds a Node-only import check that fails if `react`/`@openuidev/react-ui` appear in the `descriptors.js` module graph after build.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowlet/components test contract`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-components/src/__tests__/contract.test.ts packages/flowlet-components/package.json pnpm-lock.yaml
git commit -m "test(components): prewired contract (correspondence, uniqueness, JSON boundary)"
```

---

## Task 11: Content wrappers — Accordion, Carousel, Callout, Tags, Steps

Each follows the Card pattern (descriptor.ts + impl.tsx + test, registered in both barrels). Build them one at a time; commit per component. Schemas are complete below; confirm each OpenUI component's prop names against installed types in its impl step (the per-component test asserts rendered text and catches wrong mappings).

- [ ] **Accordion** — `components/Accordion/`

descriptor:
```ts
import { z } from "zod";
import { prewired } from "../../descriptor";
export const accordionSchema = z.object({
  items: z.array(z.object({ title: z.string(), content: z.string() })).min(1),
});
export const accordionDescriptor = prewired(
  "Accordion",
  "A vertical list of collapsible title/content sections. Use for FAQs or grouped details the user can expand.",
  accordionSchema,
);
```
impl (confirm OpenUI `Accordion`/`AccordionItem` API):
```tsx
import { Accordion as UIAccordion, AccordionItem } from "@openuidev/react-ui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { accordionSchema } from "./descriptor";
export const Accordion = createPrewiredImpl(accordionSchema, (p) => (
  <UIAccordion>
    {p.items.map((it, i) => (
      <AccordionItem key={i} title={it.title}>{it.content}</AccordionItem>
    ))}
  </UIAccordion>
));
```
test asserts a title and its content render. Register in `descriptors.ts` + `impls.ts`. Commit `feat(components): Accordion wrapper`.

- [ ] **Carousel** — `components/Carousel/`

descriptor:
```ts
export const carouselSchema = z.object({
  items: z.array(z.object({ title: z.string().optional(), body: z.string().optional(), imageUrl: z.string().optional() })).min(1),
});
export const carouselDescriptor = prewired(
  "Carousel",
  "A horizontally scrollable set of slides, each with an optional title, body, and image. Use to present multiple options or cards side by side.",
  carouselSchema,
);
```
impl: render OpenUI `Carousel` of cards; pass each `imageUrl` through `allowlistUrl(...)` (drop the image if it returns undefined). Test asserts a slide title renders. Commit `feat(components): Carousel wrapper`.

- [ ] **Callout** — `components/Callout/`

descriptor:
```ts
export const calloutSchema = z.object({
  variant: z.enum(["info", "success", "warning", "danger"]),
  title: z.string().optional(),
  text: z.string(),
});
export const calloutDescriptor = prewired(
  "Callout",
  "A highlighted message box in an info, success, warning, or danger style. Use to draw attention to a status, tip, or alert.",
  calloutSchema,
);
```
impl: map `variant` to OpenUI `Callout`'s variant prop (confirm allowed values; map `danger`→ its error/alert variant). Test asserts the text renders. Commit `feat(components): Callout wrapper`.

- [ ] **Tags** — `components/Tags/`

descriptor:
```ts
export const tagsSchema = z.object({
  items: z.array(z.object({ text: z.string(), variant: z.string().optional() })).min(1),
});
export const tagsDescriptor = prewired(
  "Tags",
  "A row of small labels/badges. Use to show categories, statuses, or keywords.",
  tagsSchema,
);
```
impl: render `TagBlock` of `Tag` (reuse the Card pattern's `Tag` usage). Test asserts a tag text renders. Commit `feat(components): Tags wrapper`.

- [ ] **Steps** — `components/Steps/`

descriptor:
```ts
export const stepsSchema = z.object({
  steps: z.array(z.object({ title: z.string().optional(), text: z.string() })).min(1),
});
export const stepsDescriptor = prewired(
  "Steps",
  "An ordered list of steps/instructions. Use for how-to sequences or progress through a process.",
  stepsSchema,
);
```
impl (confirm OpenUI `Steps`/`StepsItem`):
```tsx
import { Steps as UISteps, StepsItem } from "@openuidev/react-ui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { stepsSchema } from "./descriptor";
export const Steps = createPrewiredImpl(stepsSchema, (p) => (
  <UISteps>
    {p.steps.map((s, i) => (
      <StepsItem key={i}>{s.title ? <b>{s.title}: </b> : null}{s.text}</StepsItem>
    ))}
  </UISteps>
));
```
test asserts a step's text renders. Commit `feat(components): Steps wrapper`.

---

## Task 12: Content wrappers — List, Image, ImageGallery, Markdown, CodeBlock, Tabs

Same per-component flow. The Image/ImageGallery/Markdown tasks MUST apply the content-safety rules (spec §5.3).

- [ ] **List** — `components/List/`

descriptor:
```ts
export const listSchema = z.object({
  items: z.array(z.object({ title: z.string(), subtitle: z.string().optional() })).min(1),
});
export const listDescriptor = prewired(
  "List",
  "A vertical list of items, each with a title and optional subtitle. Use for menus, search results, or simple records.",
  listSchema,
);
```
impl: OpenUI `ListBlock`/`ListItem`. Test asserts an item title renders. Commit `feat(components): List wrapper`.

- [ ] **Image** — `components/Image/`

descriptor:
```ts
export const imageSchema = z.object({
  src: z.string(),
  alt: z.string().optional(),
  caption: z.string().optional(),
});
export const imageDescriptor = prewired(
  "Image",
  "A single image with optional alt text and caption. Use to show a picture, screenshot, or diagram.",
  imageSchema,
);
```
impl: pass `src` through `allowlistUrl(...)`; if it returns undefined, render the fallback (`<div data-testid="flowlet-blocked-image">` ) instead of an `<img>`. Test asserts: an `https:` src renders an image with the alt; a `javascript:` src renders the blocked fallback, not an `<img>` with that src. Commit `feat(components): Image wrapper (url allowlist)`.

- [ ] **ImageGallery** — `components/ImageGallery/`

descriptor:
```ts
export const imageGallerySchema = z.object({
  images: z.array(z.object({ src: z.string(), alt: z.string().optional() })).min(1),
});
export const imageGalleryDescriptor = prewired(
  "ImageGallery",
  "A grid/gallery of images. Use to present multiple related pictures.",
  imageGallerySchema,
);
```
impl: filter images through `allowlistUrl`; render OpenUI `ImageGallery`/`ImageBlock` of the survivors. Test asserts a valid image renders and a `javascript:` one is dropped. Commit `feat(components): ImageGallery wrapper`.

- [ ] **Markdown** — `components/Markdown/`

descriptor:
```ts
export const markdownSchema = z.object({ content: z.string() });
export const markdownDescriptor = prewired(
  "Markdown",
  "A block of Markdown-formatted rich text (headings, lists, links, emphasis). Use for explanatory prose or formatted content.",
  markdownSchema,
);
```
impl: render OpenUI `MarkDownRenderer` (Confirm its props; it wraps `react-markdown`.) **Disallow raw HTML** — do NOT enable `rehype-raw`/`allowDangerousHtml`. If `MarkDownRenderer` exposes an option that permits raw HTML, leave it off; if it renders raw HTML by default, fall back to `react-markdown` directly with HTML disabled. Test asserts: markdown `**bold**` renders a `<strong>`, and a raw `<script>alert(1)</script>` in content does NOT produce a `<script>` element in the DOM. Commit `feat(components): Markdown wrapper (no raw HTML)`.

- [ ] **CodeBlock** — `components/CodeBlock/`

descriptor:
```ts
export const codeBlockSchema = z.object({
  code: z.string(),
  language: z.string().optional(),
});
export const codeBlockDescriptor = prewired(
  "CodeBlock",
  "A syntax-highlighted block of source code with an optional language. Use to show code snippets or commands.",
  codeBlockSchema,
);
```
impl: OpenUI `CodeBlock` (confirm props: `code`/`language` or children). Test asserts the code text renders. Commit `feat(components): CodeBlock wrapper`.

- [ ] **Tabs** — `components/Tabs/`

descriptor:
```ts
export const tabsSchema = z.object({
  tabs: z.array(z.object({ label: z.string(), content: z.string() })).min(1),
});
export const tabsDescriptor = prewired(
  "Tabs",
  "A tabbed panel; each tab has a label and text/markdown content. Use to organize alternative views in one surface.",
  tabsSchema,
);
```
impl: OpenUI `Tabs` family (confirm `Tabs`/`TabList`/`Tab`/`TabPanel` or a data-driven API). Test asserts the first tab's label and content render. Commit `feat(components): Tabs wrapper`.

- [ ] **After all are added:** confirm `descriptors.ts` and `impls.ts` list all 15, then run the contract test.

Run: `pnpm --filter @flowlet/components test contract`
Expected: PASS — correspondence now covers 15 components.

---

## Task 13: Example page (`examples/components`)

**Files:**
- Create: `examples/components/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- Create: `examples/components/src/main.tsx`
- Create: `examples/components/src/App.tsx`

- [ ] **Step 1: Copy the scaffold from `examples/basic`**

Mirror `examples/basic/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx}`, renaming the package to `@flowlet/example-components` and adding `"@flowlet/components": "workspace:*"` to dependencies.

- [ ] **Step 2: Write `src/App.tsx`** (renders every component directly through `StubRenderer` + impls, themed)

```tsx
import type { ComponentType } from "react";
import { createStubAgent } from "@flowlet/core";
import { FlowletProvider, StubRenderer } from "@flowlet/react";
import { prewiredComponents, prewiredImpls, FlowletThemeProvider, defaultBrand } from "@flowlet/components";

const agent = createStubAgent();
const impls = prewiredImpls as Record<string, ComponentType<Record<string, unknown>>>;

// One sample node per registered component.
const samples = [
  { id: "1", kind: "component", source: "prewired", name: "Card", props: { title: "Account", subtitle: "Checking", body: "Balance is healthy.", tags: ["active"] } },
  { id: "2", kind: "component", source: "prewired", name: "Table", props: { columns: [{ key: "name", label: "Name" }, { key: "amt", label: "Amount" }], rows: [{ name: "Alice", amt: 42 }] } },
  { id: "3", kind: "component", source: "prewired", name: "Chart", props: { kind: "bar", categoryKey: "month", series: ["sales"], data: [{ month: "Jan", sales: 10 }, { month: "Feb", sales: 20 }] } },
  { id: "4", kind: "component", source: "prewired", name: "Form", props: { submitLabel: "Save", fields: [{ type: "text", name: "name", label: "Name" }] } },
  // ...add one sample per remaining registered component (Accordion, Carousel, Callout, Tags, Steps, List, Image, ImageGallery, Markdown, CodeBlock, Tabs)
] as const;

export function App() {
  return (
    <FlowletProvider agent={agent} components={prewiredComponents}>
      <FlowletThemeProvider brand={defaultBrand}>
        <div style={{ display: "grid", gap: 24, maxWidth: 720, margin: "40px auto" }}>
          {samples.map((node) => (
            <StubRenderer key={node.id} node={node as never} impls={impls} />
          ))}
        </div>
      </FlowletThemeProvider>
    </FlowletProvider>
  );
}
```

- [ ] **Step 3: Install + typecheck**

Run: `pnpm install && pnpm --filter @flowlet/example-components typecheck`
Expected: PASS.

- [ ] **Step 4: Sanity-run the dev server**

Run: `pnpm --filter @flowlet/example-components dev` (then stop it)
Expected: Vite serves with no import/runtime errors in the console; the page shows themed components.

- [ ] **Step 5: Commit**

```bash
git add examples/components pnpm-lock.yaml
git commit -m "feat(components): example page rendering the prewired set themed"
```

---

## Task 14: Full verification + build

**Files:** none (verification only) — fix any failures in the relevant component file.

- [ ] **Step 1: Run the whole package test suite**

Run: `pnpm --filter @flowlet/components test`
Expected: PASS — all component tests + contract tests green.

- [ ] **Step 2: Typecheck + build the package**

Run: `pnpm --filter @flowlet/components typecheck && pnpm --filter @flowlet/components build`
Expected: PASS; `dist/index.js` and `dist/descriptors.js` emitted.

- [ ] **Step 3: Verify the descriptors entrypoint has no React/Crayon in its built graph**

Run: `node -e "const s=require('fs').readFileSync('packages/flowlet-components/dist/descriptors.js','utf8'); if(/openuidev|react-ui|from\"react\"|from 'react'/.test(s)) { console.error('LEAK: react/crayon in descriptors'); process.exit(1);} console.log('descriptors clean');"`
Expected: prints `descriptors clean`, exit 0. (If it leaks, a descriptor.ts is importing an impl or an OpenUI symbol — fix the import.)

- [ ] **Step 4: Run the monorepo-wide checks (no regressions elsewhere)**

Run: `pnpm -w test && pnpm -w typecheck`
Expected: PASS across all packages; F1 packages unchanged and still green.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(components): F4 verification — full suite, build, descriptors-clean check green"
```

---

## Notes for the implementer

- **OpenUI prop confirmation:** for every wrapper, open the installed `node_modules/@openuidev/react-ui` types (or its Storybook/docs) and confirm the component's real prop names before finalizing the impl. The Zod schema and test are the contract you own; the OpenUI JSX is the part to verify. A wrapper test asserts rendered text/behavior, so a wrong prop name surfaces as a failing test, not a silent bug.
- **Do not modify** `@flowlet/core` or `@flowlet/react`. If a limitation there blocks you (e.g. source-unaware resolution, dropped `children`), note it — it is an F1/F3 follow-up per spec §5.1–§5.2, not part of F4.
- **CSS:** OpenUI components are unstyled without `@openuidev/react-ui/index.css`. It is imported once in `src/index.ts` (root entrypoint) and pulled into the example via that import. Never import it from `descriptors.ts`.
- **Commit cadence:** one commit per component/task as shown. Keep commits small.
