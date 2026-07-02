# ENG-197 One-Click Dev Tool (`@flowlet/cli`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `packages/flowlet-cli` exposing `flowlet init` (framework detection, theme extraction → `BrandTokens`, `tools.json` from OpenAPI with a Next.js route-scan fallback, LLM-assisted component discovery → descriptor+wrapper pairs) and a `flowlet publish` stub, all writing only into `.flowlet/` in the target repo; ground-truthed against `apps/demo-bank`.

**Architecture:** Per the locked platform architecture (Decision 3) and the ENG-197 Linear Architecture section. Deterministic extractors first (CSS custom properties / Tailwind, OpenAPI); LLM-assisted paths (route scan when no OpenAPI spec exists, component discovery) use `generateText` + zod-parse so `MockLanguageModelV3` can drive tests (same pattern as `flowlet-agent/src/policy/natural-language.ts`). All emitted artifacts match existing contracts: `theme.json` validates against `brandTokensSchema` (`@flowlet/components`), component descriptors produce `RegisteredComponent` (`@flowlet/core`), tool annotations mirror `ToolAnnotations` (`@flowlet/agent`). The `tools.json` top-level manifest shape is NOT frozen — the CLI owns a clearly-marked draft zod schema and the findings doc surfaces every open schema question for the contracts-freeze session.

**Tech Stack:** Node/TS ESM, tsc build, vitest, `ai` 6.0.28 + `@ai-sdk/anthropic`, zod v3, `yaml`, `sucrase` (TSX syntax validation), turbo workspace conventions.

**Scope guards (binding):**
- Never modify existing code in the target repo; only add files under `.flowlet/` (and the CLI may print instructions).
- `flowlet publish` is a stub — no registry exists (ENG-198 owns it).
- `flowlet dev` (listed in the architecture) is NOT in this session's scope — record in findings.
- tRPC extraction: skipped as not-cheap; record in findings.
- No invented contract shapes: anything not already typed in `flowlet-core`/`flowlet-components`/`flowlet-agent` is emitted under a draft schema flagged for contracts-freeze.

---

## File structure

```
packages/flowlet-cli/
  package.json                  @flowlet/cli, bin "flowlet"
  tsconfig.json                 mirrors flowlet-agent
  vitest.config.ts
  src/
    cli.ts                      #! entry; argv dispatch (init | publish | --help | --version)
    index.ts                    re-exports for programmatic use/tests
    fsx.ts                      walk() + writeGenerated() helpers (no glob dep)
    detect.ts                   framework/tailwind/openapi detection
    report.ts                   InitReport type + renderReport()
    llm.ts                      cliModel() + generateJson() (generateText + zod parse + 1 retry)
    theme/
      css-vars.ts               @theme/:root/dark-scope custom-property parser
      tailwind-config.ts        Tailwind v3 JS-config extractor (dynamic import)
      map-to-brand.ts           name-heuristic mapping → BrandTokens
      extract-theme.ts          orchestrates → .flowlet/theme.json
    tools/
      manifest.ts               DRAFT tools.json zod schema (flagged for contracts-freeze)
      openapi.ts                OpenAPI 3.x → tool entries (deterministic)
      route-scan.ts             Next.js route.ts LLM fallback → tool entries
      extract-tools.ts          orchestrates → .flowlet/tools.json
    components/
      scan.ts                   candidate .tsx discovery heuristics
      analyze.ts                LLM analysis → ComponentAnalysis (structured)
      codegen.ts                descriptor.ts/impl.tsx/entry.ts/vite.config.ts/README templates + sucrase check
      extract-components.ts     orchestrates → .flowlet/components/
    init.ts                     flowlet init orchestrator
    publish.ts                  stub
  test/
    fixtures/
      openapi/maple.json        OpenAPI fixture
      mini-app/                 tiny Next-shaped fixture app for e2e init test
packages/flowlet-components/package.json   ADD "./theme" export (react-free)
apps/demo-bank/.flowlet/        generated ground-truth output (committed as evidence)
docs/superpowers/specs/2026-07-02-flowlet-eng197-extraction-fidelity-findings.md
```

Pinned contract facts (verified in-repo):
- `brandTokensSchema` / `BrandTokens` / `defaultBrand`: `packages/flowlet-components/src/theme/brand.ts` (zod-only, react-free file; package export map must gain a react-free `./theme` entry).
- `RegisteredComponent { name, description, propsSchema: FlowletSchema<unknown>, source: "prewired"|"host"|"generated" }`: `packages/flowlet-core/src/registry.ts`, `ui.ts`.
- `ToolAnnotations { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }`: `packages/flowlet-agent/src/descriptor.ts` (MCP hint shape). "mutating" ⇔ `readOnlyHint: false`, "dangerous" ⇔ `destructiveHint: true`.
- Sandbox bundle contract: entry sets `window.__FLOWLET_HOST__ = { [descriptorName]: ComponentType<Record<string, unknown>> }` (`packages/flowlet-components/bundle/entry.ts`); impls safeParse props and render a fallback div on invalid props (`impl-helpers/create-impl.tsx`).
- Build preset: `flowletHostPreset({ entry, version, outDir })` from `@flowlet/stage/build`.
- LLM default model id: `claude-sonnet-4-6` (demo-bank `DEMO_MODEL`); CLI env override `FLOWLET_CLI_MODEL`, key `ANTHROPIC_API_KEY`.
- Mock-model testing: `MockLanguageModelV3` from `ai/test`; use `generateText`, never `generateObject` (repo precedent: `natural-language.ts`).

---

### Task 1: React-free `./theme` export on `@flowlet/components`

The CLI must import `brandTokensSchema` without dragging React/OpenUI into a Node CLI process.

**Files:**
- Modify: `packages/flowlet-components/package.json` (exports map only)

- [ ] **Step 1: Add the export**

In `packages/flowlet-components/package.json`, add to `"exports"` after the `"./descriptors"` entry:

```json
    "./theme": {
      "types": "./dist/theme/brand.d.ts",
      "default": "./dist/theme/brand.js"
    }
```

- [ ] **Step 2: Verify it builds and resolves**

Run: `pnpm --filter @flowlet/components build && node -e "import('@flowlet/components/theme').then(m => console.log(Object.keys(m)))" --input-type=module`
(Or from repo root: `node --input-type=module -e "import('./packages/flowlet-components/dist/theme/brand.js').then(m=>console.log(Object.keys(m)))"`)
Expected: `[ 'brandTokensSchema', 'defaultBrand' ]`

- [ ] **Step 3: Commit**

```bash
git add packages/flowlet-components/package.json
git commit -m "feat(components): react-free ./theme export for the CLI extractor"
```

---

### Task 2: Scaffold `packages/flowlet-cli`

**Files:**
- Create: `packages/flowlet-cli/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/cli.ts`, `src/index.ts`
- Test: `packages/flowlet-cli/src/cli.test.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "@flowlet/cli",
  "version": "0.0.0",
  "type": "module",
  "bin": { "flowlet": "./dist/cli.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "3.0.12",
    "@flowlet/components": "workspace:*",
    "ai": "6.0.28",
    "sucrase": "^3.35.0",
    "yaml": "^2.5.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: tsconfig.json** (copy `packages/flowlet-agent/tsconfig.json`, adjust: no JSX needed; include `src`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

(If flowlet-agent's tsconfig differs materially — e.g. `module: ESNext` + `moduleResolution: Bundler` — mirror flowlet-agent instead; consistency wins.)

- [ ] **Step 3: vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

- [ ] **Step 4: src/cli.ts — dispatch only, logic lives in modules**

```ts
#!/usr/bin/env node
/**
 * @flowlet/cli — the one-click dev tool (ENG-197).
 *   flowlet init [dir]     extract theme/tools/components into <dir>/.flowlet/
 *   flowlet publish [dir]  stub until the cloud registry lands (ENG-198)
 */
import { runInit } from "./init.js";
import { runPublish } from "./publish.js";

const HELP = `flowlet — Flowlet one-click dev tool

Usage:
  flowlet init [dir] [--skip-llm] [--force]   Extract theme, tools, components into .flowlet/
  flowlet publish [dir]                       Publish the manifest (stub — registry lands with ENG-198)

Options:
  --skip-llm   Skip LLM-assisted steps (route scan, component discovery)
  --force      Overwrite existing .flowlet/ files
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const dir = rest.find((a) => !a.startsWith("--")) ?? process.cwd();
  switch (cmd) {
    case "init":
      return runInit({ targetDir: dir, skipLlm: flags.has("--skip-llm"), force: flags.has("--force") });
    case "publish":
      return runPublish({ targetDir: dir });
    case "--version":
      console.log("0.0.0");
      return 0;
    default:
      console.log(HELP);
      return cmd === undefined || cmd === "--help" ? 0 : 1;
  }
}

// Only auto-run when invoked as a bin, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

`src/index.ts`:

```ts
export { main } from "./cli.js";
```

(Until Tasks 16–17 land, stub `src/init.ts` / `src/publish.ts` as `export async function runInit(): Promise<number> { throw new Error("not implemented"); }` etc. — replaced by their tasks.)

- [ ] **Step 5: Write the failing test** — `src/cli.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("cli dispatch", () => {
  it("prints help and exits 0 with no command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main([])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("flowlet init");
    log.mockRestore();
  });

  it("exits 1 on unknown command", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["frobnicate"])).toBe(1);
  });
});
```

- [ ] **Step 6: Run tests** — `pnpm --filter @flowlet/cli test` → PASS (2). Then `pnpm install` at root first so the workspace links.

- [ ] **Step 7: Commit**

```bash
git add packages/flowlet-cli pnpm-lock.yaml
git commit -m "feat(cli): scaffold @flowlet/cli with init/publish dispatch"
```

---

### Task 3: `fsx.ts` walker + generated-file writer

**Files:**
- Create: `packages/flowlet-cli/src/fsx.ts`
- Test: `packages/flowlet-cli/src/fsx.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { walk, writeGenerated } from "./fsx.js";

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "flowlet-cli-"));
}

describe("walk", () => {
  it("finds matching files and skips node_modules/.flowlet", async () => {
    const dir = await scratch();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "node_modules/x"), { recursive: true });
    await mkdir(path.join(dir, ".flowlet"), { recursive: true });
    await writeFile(path.join(dir, "src/a.css"), "");
    await writeFile(path.join(dir, "node_modules/x/b.css"), "");
    await writeFile(path.join(dir, ".flowlet/c.css"), "");
    const hits = await walk(dir, (p) => p.endsWith(".css"));
    expect(hits).toEqual([path.join(dir, "src/a.css")]);
  });
});

describe("writeGenerated", () => {
  it("refuses to overwrite without force", async () => {
    const dir = await scratch();
    await writeGenerated(path.join(dir, "out.json"), "1", { force: false });
    await expect(writeGenerated(path.join(dir, "out.json"), "2", { force: false })).rejects.toThrow(/--force/);
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @flowlet/cli test -- fsx` → FAIL (module missing)

- [ ] **Step 3: Implement `src/fsx.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".flowlet", "dist", "dist-sandbox", "build", "coverage", "out",
]);

/** Recursively list files under `root` for which `keep(relPath)` is true. Sorted, capped. */
export async function walk(
  root: string,
  keep: (relPath: string) => boolean,
  maxFiles = 20_000,
): Promise<string[]> {
  const results: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, extraction is best-effort
    }
    for (const e of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await visit(full);
      } else if (keep(path.relative(root, full))) {
        results.push(full);
      }
    }
  }
  await visit(root);
  return results.sort();
}

/** Write a generated artifact; refuse to clobber developer-edited output unless forced. */
export async function writeGenerated(
  file: string,
  content: string,
  opts: { force: boolean },
): Promise<void> {
  if (!opts.force) {
    try {
      await fs.access(file);
      throw new Error(`${file} already exists — outputs are developer-editable; re-run with --force to overwrite`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
```

- [ ] **Step 4: Run** — same command → PASS
- [ ] **Step 5: Commit** — `git add -A packages/flowlet-cli && git commit -m "feat(cli): fs walker and guarded artifact writer"`

---

### Task 4: Framework detection (`detect.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/detect.ts`
- Test: `packages/flowlet-cli/src/detect.test.ts`

- [ ] **Step 1: Failing test** (build a temp fixture per case)

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTarget } from "./detect.js";

async function makeApp(pkg: object, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "flowlet-detect-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}

describe("detectTarget", () => {
  it("detects next + tailwind v4 css-first + no openapi", async () => {
    const dir = await makeApp(
      { dependencies: { next: "15.0.0", tailwindcss: "^4.0.0" } },
      { "src/app/globals.css": '@import "tailwindcss";\n@theme { --color-bg: #fff; }' },
    );
    const info = await detectTarget(dir);
    expect(info.framework).toBe("next");
    expect(info.tailwind).toBe("v4-css");
    expect(info.cssFiles).toHaveLength(1);
    expect(info.openapiPath).toBeNull();
  });

  it("detects vite + tailwind v3 config + openapi spec", async () => {
    const dir = await makeApp(
      { devDependencies: { vite: "5.0.0", tailwindcss: "^3.4.0" } },
      { "tailwind.config.js": "export default {}", "openapi.json": '{"openapi":"3.0.0"}' },
    );
    const info = await detectTarget(dir);
    expect(info.framework).toBe("vite");
    expect(info.tailwind).toBe("v3-config");
    expect(info.tailwindConfigPath).toMatch(/tailwind\.config\.js$/);
    expect(info.openapiPath).toMatch(/openapi\.json$/);
  });

  it("handles a bare repo", async () => {
    const dir = await makeApp({}, {});
    const info = await detectTarget(dir);
    expect(info).toMatchObject({ framework: "unknown", tailwind: "none", openapiPath: null });
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/detect.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "./fsx.js";

export interface FrameworkInfo {
  framework: "next" | "vite" | "remix" | "unknown";
  tailwind: "v4-css" | "v3-config" | "none";
  cssFiles: string[];
  tailwindConfigPath: string | null;
  openapiPath: string | null;
}

const OPENAPI_CANDIDATES = [
  "openapi.json", "openapi.yaml", "openapi.yml",
  "swagger.json", "swagger.yaml",
  "docs/openapi.json", "docs/openapi.yaml", "public/openapi.json", "api/openapi.json",
];
const TW_CONFIGS = ["tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs", "tailwind.config.ts"];

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

export async function detectTarget(targetDir: string): Promise<FrameworkInfo> {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, "package.json"), "utf8"));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // no/invalid package.json — everything stays "unknown"
  }

  const framework: FrameworkInfo["framework"] =
    deps["next"] ? "next"
    : deps["@remix-run/react"] ? "remix"
    : deps["vite"] ? "vite"
    : "unknown";

  const cssFiles = await walk(targetDir, (p) => p.endsWith(".css"), 500);

  let tailwindConfigPath: string | null = null;
  for (const c of TW_CONFIGS) {
    if (await exists(path.join(targetDir, c))) { tailwindConfigPath = path.join(targetDir, c); break; }
  }

  let tailwind: FrameworkInfo["tailwind"] = "none";
  if (tailwindConfigPath) tailwind = "v3-config";
  else if (deps["tailwindcss"]?.match(/(^|\^|~)4\./)) tailwind = "v4-css";
  else if (deps["tailwindcss"]) {
    // dep present, no config file — assume CSS-first (v4 style)
    tailwind = "v4-css";
  }

  let openapiPath: string | null = null;
  for (const c of OPENAPI_CANDIDATES) {
    if (await exists(path.join(targetDir, c))) { openapiPath = path.join(targetDir, c); break; }
  }

  return { framework, tailwind, cssFiles, tailwindConfigPath, openapiPath };
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): framework/tailwind/openapi detection"`

---

### Task 5: CSS custom-property parser (`theme/css-vars.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/theme/css-vars.ts`
- Test: `packages/flowlet-cli/src/theme/css-vars.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseCssVars } from "./css-vars.js";

const CSS = `
@import "tailwindcss";
@theme {
  --color-bg: #FBFBFA;
  --radius-card: 14px;
}
:root { --accent: #1B1C22; }
.dark { --color-bg: #111111; }
@media (prefers-color-scheme: dark) {
  :root { --accent: #FFFFFF; }
}
body { color: var(--color-ink); }
`;

describe("parseCssVars", () => {
  it("extracts declarations with dark-scope flags", () => {
    const vars = parseCssVars(CSS, "globals.css");
    expect(vars).toContainEqual({ name: "--color-bg", value: "#FBFBFA", file: "globals.css", darkScope: false });
    expect(vars).toContainEqual({ name: "--radius-card", value: "14px", file: "globals.css", darkScope: false });
    expect(vars).toContainEqual({ name: "--accent", value: "#1B1C22", file: "globals.css", darkScope: false });
    expect(vars).toContainEqual({ name: "--color-bg", value: "#111111", file: "globals.css", darkScope: true });
    expect(vars).toContainEqual({ name: "--accent", value: "#FFFFFF", file: "globals.css", darkScope: true });
    // usage (var(--color-ink)) is not a declaration
    expect(vars.find((v) => v.name === "--color-ink")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/theme/css-vars.ts`**

```ts
/**
 * Minimal CSS custom-property declaration scanner. Not a full CSS parser —
 * tracks brace depth and whether the enclosing block/at-rule looks dark-scoped
 * (`.dark`, `[data-theme="dark"]`, `@media (prefers-color-scheme: dark)`).
 * Good enough for design-token sheets; anything it misses is hand-editable output.
 */
export interface CssVarDecl {
  name: string;
  value: string;
  file: string;
  darkScope: boolean;
}

const DARK_SELECTOR = /(\.dark\b|\[data-theme=["']?dark["']?\]|prefers-color-scheme:\s*dark)/;

export function parseCssVars(css: string, file: string): CssVarDecl[] {
  const out: CssVarDecl[] = [];
  // Strip comments first.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Stack of "is this block dark-scoped" flags.
  const darkStack: boolean[] = [];
  let selectorBuf = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const parentDark = darkStack.some(Boolean);
      darkStack.push(parentDark || DARK_SELECTOR.test(selectorBuf));
      selectorBuf = "";
    } else if (ch === "}") {
      darkStack.pop();
      selectorBuf = "";
    } else if (ch === ";") {
      const decl = selectorBuf.trim();
      const m = decl.match(/^(--[\w-]+)\s*:\s*(.+)$/s);
      if (m && m[1] && m[2]) {
        out.push({ name: m[1], value: m[2].trim(), file, darkScope: darkStack.some(Boolean) });
      }
      selectorBuf = "";
    } else {
      selectorBuf += ch;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): css custom-property parser with dark-scope tracking"`

---

### Task 6: Tailwind v3 config extractor (`theme/tailwind-config.ts`)

Dynamic-`import()`s a plain-JS config (dev-time, developer's own repo). TS configs are reported as unsupported (hand-edit path); recorded honestly in the report.

**Files:**
- Create: `packages/flowlet-cli/src/theme/tailwind-config.ts`
- Test: `packages/flowlet-cli/src/theme/tailwind-config.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractTailwindVars } from "./tailwind-config.js";

describe("extractTailwindVars", () => {
  it("flattens theme.extend colors/radius/font into CssVarDecl-shaped entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tw-"));
    const cfg = path.join(dir, "tailwind.config.mjs");
    await writeFile(cfg, `export default {
      theme: { extend: {
        colors: { primary: "#123456", surface: { DEFAULT: "#ffffff", dark: "#000000" } },
        borderRadius: { card: "12px" },
        fontFamily: { sans: ["Inter", "sans-serif"] },
      } },
    };`);
    const { vars, error } = await extractTailwindVars(cfg);
    expect(error).toBeNull();
    expect(vars).toContainEqual(expect.objectContaining({ name: "--color-primary", value: "#123456" }));
    expect(vars).toContainEqual(expect.objectContaining({ name: "--color-surface", value: "#ffffff" }));
    expect(vars).toContainEqual(expect.objectContaining({ name: "--radius-card", value: "12px" }));
    expect(vars).toContainEqual(expect.objectContaining({ name: "--font-sans", value: "Inter, sans-serif" }));
  });

  it("reports TS configs as unsupported instead of throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tw-"));
    const cfg = path.join(dir, "tailwind.config.ts");
    await writeFile(cfg, "export default {} satisfies unknown;");
    const { vars, error } = await extractTailwindVars(cfg);
    expect(vars).toEqual([]);
    expect(error).toMatch(/TypeScript/);
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/theme/tailwind-config.ts`**

```ts
import { pathToFileURL } from "node:url";
import type { CssVarDecl } from "./css-vars.js";

/**
 * Extract theme tokens from a Tailwind v3 JS config by importing it (dev-time,
 * the developer's own code). Values are normalised into the same CssVarDecl
 * shape the CSS scanner produces so one mapping layer serves both.
 * TypeScript configs are NOT executed — reported for hand-editing instead.
 */
export async function extractTailwindVars(
  configPath: string,
): Promise<{ vars: CssVarDecl[]; error: string | null }> {
  if (configPath.endsWith(".ts")) {
    return { vars: [], error: "TypeScript Tailwind configs are not executed; fill theme.json by hand or convert to JS" };
  }
  let theme: Record<string, unknown>;
  try {
    const mod = await import(pathToFileURL(configPath).href);
    const cfg = (mod.default ?? mod) as { theme?: { extend?: Record<string, unknown> } & Record<string, unknown> };
    theme = { ...(cfg.theme ?? {}), ...((cfg.theme?.extend as Record<string, unknown>) ?? {}) };
  } catch (err) {
    return { vars: [], error: `could not load ${configPath}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const vars: CssVarDecl[] = [];
  const file = configPath;

  const colors = theme["colors"] as Record<string, unknown> | undefined;
  if (colors) {
    for (const [name, v] of Object.entries(colors)) {
      const value =
        typeof v === "string" ? v
        : v && typeof v === "object" ? ((v as Record<string, unknown>)["DEFAULT"] ?? (v as Record<string, unknown>)["500"]) : undefined;
      if (typeof value === "string") vars.push({ name: `--color-${name}`, value, file, darkScope: false });
    }
  }
  const radius = theme["borderRadius"] as Record<string, unknown> | undefined;
  if (radius) {
    for (const [name, v] of Object.entries(radius)) {
      if (typeof v === "string") vars.push({ name: name === "DEFAULT" ? "--radius" : `--radius-${name}`, value: v, file, darkScope: false });
    }
  }
  const fonts = theme["fontFamily"] as Record<string, unknown> | undefined;
  if (fonts) {
    for (const [name, v] of Object.entries(fonts)) {
      const value = Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : undefined;
      if (value) vars.push({ name: `--font-${name}`, value, file, darkScope: false });
    }
  }
  return { vars, error: null };
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): tailwind v3 config token extraction"`

---

### Task 7: Brand mapping heuristics (`theme/map-to-brand.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/theme/map-to-brand.ts`
- Test: `packages/flowlet-cli/src/theme/map-to-brand.test.ts`

- [ ] **Step 1: Failing test** (uses demo-bank's real vars as the primary case)

```ts
import { describe, expect, it } from "vitest";
import { mapVarsToBrand } from "./map-to-brand.js";
import type { CssVarDecl } from "./css-vars.js";

const v = (name: string, value: string, darkScope = false): CssVarDecl => ({ name, value, file: "globals.css", darkScope });

describe("mapVarsToBrand", () => {
  it("maps demo-bank's @theme vars onto BrandTokens slots", () => {
    const result = mapVarsToBrand([
      v("--color-bg", "#FBFBFA"), v("--color-surface", "#FFFFFF"), v("--color-ink", "#111111"),
      v("--color-ink-soft", "#46443F"), v("--color-muted", "#908C85"), v("--color-border", "#ECEBE8"),
      v("--radius-card", "14px"), v("--font-sans", "var(--font-inter)"),
    ]);
    expect(result.brand).toMatchObject({
      version: 1,
      background: "#FBFBFA",
      surface: "#FFFFFF",
      text: "#111111",
      mutedText: "#908C85",
      radius: "14px",
      mode: "light",
    });
    // no accent-ish var exists — defaulted and reported
    expect(result.defaulted).toContain("accent");
    expect(result.unmapped.map((u) => u.name)).toContain("--color-border");
  });

  it("prefers accent-named vars and rejects non-hex colors", () => {
    const result = mapVarsToBrand([
      v("--color-primary", "oklch(0.7 0.1 250)"), v("--color-accent", "#FF0000"), v("--color-bg", "#FFFFFF"),
    ]);
    expect(result.brand?.accent).toBe("#FF0000");
    expect(result.unmapped.map((u) => u.name)).toContain("--color-primary");
  });

  it("flags a dark variant when dark-scoped vars exist", () => {
    const result = mapVarsToBrand([v("--color-bg", "#FFFFFF"), v("--color-bg", "#000000", true)]);
    expect(result.hasDarkVariant).toBe(true);
    expect(result.brand?.mode).toBe("light");
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/theme/map-to-brand.ts`**

```ts
import { brandTokensSchema, defaultBrand } from "@flowlet/components/theme";
import type { BrandTokens } from "@flowlet/components/theme";
import type { CssVarDecl } from "./css-vars.js";

export interface BrandMappingResult {
  brand: BrandTokens | null;
  /** slot -> winning var name, for the report */
  matched: Record<string, string>;
  /** BrandTokens slots that fell back to defaultBrand values */
  defaulted: string[];
  /** declarations we saw but did not use */
  unmapped: CssVarDecl[];
  hasDarkVariant: boolean;
}

const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Ordered name fragments per slot; first var whose name contains a fragment wins. */
const COLOR_SLOTS: Array<{ slot: "accent" | "background" | "surface" | "text" | "mutedText"; fragments: string[] }> = [
  { slot: "accent", fragments: ["accent", "primary", "brand", "cta"] },
  { slot: "background", fragments: ["background", "-bg"] },
  { slot: "surface", fragments: ["surface", "card", "panel"] },
  { slot: "mutedText", fragments: ["muted", "fg-muted", "text-muted", "secondary-text"] },
  { slot: "text", fragments: ["-ink", "text", "-fg", "foreground"] },
];

function pick(vars: CssVarDecl[], fragments: string[], accept: (v: string) => boolean): CssVarDecl | undefined {
  for (const frag of fragments) {
    // exact-suffix beats loose-contains so "--color-ink" wins over "--color-ink-soft"
    const exact = vars.find((v) => (v.name.endsWith(frag) || v.name === `--${frag.replace(/^-/, "")}`) && accept(v.value));
    if (exact) return exact;
    const loose = vars.find((v) => v.name.includes(frag) && accept(v.value));
    if (loose) return loose;
  }
  return undefined;
}

export function mapVarsToBrand(all: CssVarDecl[]): BrandMappingResult {
  const light = all.filter((v) => !v.darkScope);
  const hasDarkVariant = all.some((v) => v.darkScope);
  const used = new Set<CssVarDecl>();
  const matched: Record<string, string> = {};
  const defaulted: string[] = [];
  const draft: Record<string, unknown> = { version: 1, mode: "light" };

  for (const { slot, fragments } of COLOR_SLOTS) {
    const hit = pick(light.filter((v) => !used.has(v)), fragments, (val) => HEX.test(val));
    if (hit) { used.add(hit); matched[slot] = hit.name; draft[slot] = hit.value; }
    else { defaulted.push(slot); draft[slot] = defaultBrand[slot]; }
  }

  const radius = pick(light, ["radius"], (val) => /^\d+(\.\d+)?px$/.test(val));
  if (radius) { used.add(radius); matched["radius"] = radius.name; draft["radius"] = radius.value; }
  else { defaulted.push("radius"); draft["radius"] = defaultBrand.radius; }

  const font = pick(light, ["font-sans", "font-family", "font"], (val) => val.length > 0);
  if (font) { used.add(font); matched["fontFamily"] = font.name; draft["fontFamily"] = font.value; }
  else { defaulted.push("fontFamily"); draft["fontFamily"] = defaultBrand.fontFamily; }

  const parsed = brandTokensSchema.safeParse(draft);
  return {
    brand: parsed.success ? parsed.data : null,
    matched,
    defaulted,
    unmapped: light.filter((v) => !used.has(v)),
    hasDarkVariant,
  };
}
```

- [ ] **Step 4: Run** — PASS. Iterate on fragment ordering until the demo-bank case maps exactly as the test asserts (`--color-ink-soft` must NOT beat `--color-ink`; `-bg` must not match `--color-bg`'s substring in other names first).
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): css-var to BrandTokens mapping heuristics"`

---

### Task 8: Theme extraction orchestrator (`theme/extract-theme.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/theme/extract-theme.ts`
- Test: `packages/flowlet-cli/src/theme/extract-theme.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractTheme } from "./extract-theme.js";
import { detectTarget } from "../detect.js";

describe("extractTheme", () => {
  it("writes a valid theme.json from a v4 css app", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "src/app"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/globals.css"),
      '@theme { --color-bg: #FBFBFA; --color-surface: #FFFFFF; --color-ink: #111111; --color-muted: #908C85; --radius-card: 14px; }',
    );
    const info = await detectTarget(dir);
    const summary = await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".flowlet/theme.json"), "utf8"));
    expect(written.background).toBe("#FBFBFA");
    expect(written.version).toBe(1);
    expect(summary.defaulted).toContain("accent");
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/theme/extract-theme.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FrameworkInfo } from "../detect.js";
import { parseCssVars, type CssVarDecl } from "./css-vars.js";
import { extractTailwindVars } from "./tailwind-config.js";
import { mapVarsToBrand, type BrandMappingResult } from "./map-to-brand.js";
import { writeGenerated } from "../fsx.js";

export interface ThemeSummary extends Omit<BrandMappingResult, "brand"> {
  written: boolean;
  errors: string[];
  varCount: number;
}

export async function extractTheme(
  targetDir: string,
  info: FrameworkInfo,
  opts: { force: boolean },
): Promise<ThemeSummary> {
  const vars: CssVarDecl[] = [];
  const errors: string[] = [];

  for (const cssFile of info.cssFiles) {
    const css = await fs.readFile(cssFile, "utf8");
    vars.push(...parseCssVars(css, path.relative(targetDir, cssFile)));
  }
  if (info.tailwindConfigPath) {
    const { vars: twVars, error } = await extractTailwindVars(info.tailwindConfigPath);
    vars.push(...twVars);
    if (error) errors.push(error);
  }

  const result = mapVarsToBrand(vars);
  let written = false;
  if (result.brand) {
    await writeGenerated(
      path.join(targetDir, ".flowlet/theme.json"),
      JSON.stringify(result.brand, null, 2) + "\n",
      opts,
    );
    written = true;
  } else {
    errors.push("could not assemble a valid BrandTokens object — write .flowlet/theme.json by hand");
  }
  const { brand: _brand, ...rest } = result;
  return { ...rest, written, errors, varCount: vars.length };
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): theme extraction pipeline writing .flowlet/theme.json"`

---

### Task 9: Draft tools manifest schema (`tools/manifest.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/tools/manifest.ts`
- Test: `packages/flowlet-cli/src/tools/manifest.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { toolsManifestSchema } from "./manifest.js";

describe("toolsManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    const m = {
      version: 1,
      extractedFrom: { kind: "openapi", path: "openapi.json" },
      tools: [{
        name: "list_transactions",
        description: "List transactions",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        http: { method: "get", path: "/api/transactions" },
        source: "openapi",
      }],
      events: [],
    };
    expect(toolsManifestSchema.parse(m)).toBeTruthy();
  });

  it("rejects bad tool names", () => {
    const bad = { version: 1, tools: [{ name: "Bad Name!", description: "x", inputSchema: {}, annotations: {}, source: "openapi" }], events: [] };
    expect(() => toolsManifestSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/tools/manifest.ts`**

```ts
import { z } from "zod";

/**
 * DRAFT tools.json schema — ENG-197 extractor output.
 *
 * The frozen manifest schema is owned by the contracts-freeze track; this file
 * matches the shapes that already exist in the codebase and must be reconciled
 * when the freeze lands:
 *  - `annotations` mirrors ToolAnnotations (packages/flowlet-agent/src/descriptor.ts,
 *    MCP hint shape). "mutating" == readOnlyHint:false, "dangerous" == destructiveHint:true.
 *  - `events` declares host event types usable as automation triggers
 *    (architecture Decision 3 / Decision 5); the extractor emits [] today.
 * Open questions for the freeze are listed in the ENG-197 fidelity findings doc.
 */

export const toolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

export const httpBindingSchema = z.object({
  method: z.enum(["get", "post", "put", "patch", "delete", "head"]),
  path: z.string().startsWith("/"),
});

export const toolEntrySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case tool names"),
  description: z.string().min(1),
  /** JSON Schema for the tool input (object). Kept opaque here. */
  inputSchema: z.record(z.unknown()),
  annotations: toolAnnotationsSchema,
  http: httpBindingSchema.optional(),
  source: z.enum(["openapi", "route-scan"]),
});

export const hostEventSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export const toolsManifestSchema = z.object({
  version: z.literal(1),
  extractedFrom: z.object({ kind: z.enum(["openapi", "route-scan"]), path: z.string() }).optional(),
  tools: z.array(toolEntrySchema),
  events: z.array(hostEventSchema),
});

export type ToolEntry = z.infer<typeof toolEntrySchema>;
export type ToolsManifest = z.infer<typeof toolsManifestSchema>;

/** Deterministic annotation rules shared by both extractors. */
export function annotationsFor(method: string, name: string): z.infer<typeof toolAnnotationsSchema> {
  const m = method.toLowerCase();
  const destructiveName = /(^|_)(delete|remove|destroy|cancel|close)(_|$)/.test(name);
  if (m === "get" || m === "head") return { readOnlyHint: true, openWorldHint: false };
  return {
    readOnlyHint: false,
    idempotentHint: m === "put" || m === "delete" || undefined,
    destructiveHint: m === "delete" || destructiveName || undefined,
    openWorldHint: false,
  };
}
```

- [ ] **Step 4: Run** — PASS (add a third test: `annotationsFor("delete", "delete_payee")` → `destructiveHint: true`; `annotationsFor("get", "x")` → `readOnlyHint: true`).
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): draft tools.json manifest schema (flagged for contracts-freeze)"`

---

### Task 10: OpenAPI converter (`tools/openapi.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/tools/openapi.ts`
- Create: `packages/flowlet-cli/test/fixtures/openapi/maple.json`
- Test: `packages/flowlet-cli/src/tools/openapi.test.ts`

- [ ] **Step 1: Fixture** — `test/fixtures/openapi/maple.json`

```json
{
  "openapi": "3.0.0",
  "info": { "title": "Maple API", "version": "1.0.0" },
  "components": {
    "schemas": {
      "Payment": {
        "type": "object",
        "properties": { "amount": { "type": "number" }, "payeeId": { "type": "string" } },
        "required": ["amount", "payeeId"]
      }
    }
  },
  "paths": {
    "/api/transactions": {
      "get": {
        "operationId": "listTransactions",
        "summary": "List recent transactions",
        "parameters": [
          { "name": "limit", "in": "query", "schema": { "type": "integer" }, "description": "Max rows" }
        ],
        "responses": { "200": { "description": "ok" } }
      }
    },
    "/api/transactions/{id}": {
      "get": {
        "summary": "Get one transaction",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
        "responses": { "200": { "description": "ok" } }
      }
    },
    "/api/payments": {
      "post": {
        "operationId": "createPayment",
        "summary": "Create a payment",
        "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Payment" } } } },
        "responses": { "201": { "description": "created" } }
      }
    },
    "/api/payees/{id}": {
      "delete": {
        "operationId": "deletePayee",
        "summary": "Delete a payee",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
        "responses": { "204": { "description": "gone" } }
      }
    }
  }
}
```

- [ ] **Step 2: Failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertOpenApi } from "./openapi.js";

const fixture = path.join(fileURLToPath(new URL(".", import.meta.url)), "../../test/fixtures/openapi/maple.json");

describe("convertOpenApi", () => {
  it("converts operations to tool entries with annotations", async () => {
    const tools = await convertOpenApi(fixture);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_transactions", "get_api_transactions_by_id", "create_payment", "delete_payee"]),
    );
    const list = tools.find((t) => t.name === "list_transactions")!;
    expect(list.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect((list.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("limit");
    const del = tools.find((t) => t.name === "delete_payee")!;
    expect(del.annotations.destructiveHint).toBe(true);
    const create = tools.find((t) => t.name === "create_payment")!;
    // $ref resolved into the body property
    const body = (create.inputSchema as { properties: { body: { properties: Record<string, unknown> } } }).properties.body;
    expect(body.properties).toHaveProperty("amount");
    expect(create.http).toEqual({ method: "post", path: "/api/payments" });
  });
});
```

- [ ] **Step 3: Run** — FAIL

- [ ] **Step 4: Implement `src/tools/openapi.ts`**

```ts
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { annotationsFor, type ToolEntry } from "./manifest.js";

type JsonObj = Record<string, unknown>;
const METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

export async function convertOpenApi(specPath: string): Promise<ToolEntry[]> {
  const raw = await fs.readFile(specPath, "utf8");
  const doc = (specPath.endsWith(".yaml") || specPath.endsWith(".yml") ? YAML.parse(raw) : JSON.parse(raw)) as JsonObj;
  const paths = (doc["paths"] ?? {}) as Record<string, JsonObj>;
  const tools: ToolEntry[] = [];

  for (const [route, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = item[method] as JsonObj | undefined;
      if (!op) continue;
      const name = toolName(op, method, route);
      const description =
        [op["summary"], op["description"]].filter((s) => typeof s === "string" && s.length > 0).join(". ") ||
        `${method.toUpperCase()} ${route}`;
      tools.push({
        name,
        description,
        inputSchema: buildInputSchema(doc, item, op),
        annotations: annotationsFor(method, name),
        http: { method, path: route },
        source: "openapi",
      });
    }
  }
  return tools;
}

function toolName(op: JsonObj, method: string, route: string): string {
  const opId = op["operationId"];
  if (typeof opId === "string" && opId.length > 0) return snake(opId);
  const segs = route
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith("{") ? `by_${s.slice(1, -1)}` : s));
  return snake([method, ...segs].join("_"));
}

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** Resolve local #/... $refs (cycle-guarded); leave external refs untouched. */
export function resolveRefs(doc: JsonObj, node: unknown, seen = new Set<string>()): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(doc, n, seen));
  if (node === null || typeof node !== "object") return node;
  const obj = node as JsonObj;
  const ref = obj["$ref"];
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (seen.has(ref)) return { $ref: ref }; // cycle — leave as-is
    const target = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((acc, k) => (acc as JsonObj | undefined)?.[k], doc);
    return resolveRefs(doc, target, new Set([...seen, ref]));
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(doc, v, seen)]));
}

/**
 * Input schema convention (documented in .flowlet/README.md and the findings doc,
 * pending contracts-freeze): path+query params become top-level properties;
 * a JSON requestBody becomes a `body` property.
 */
function buildInputSchema(doc: JsonObj, pathItem: JsonObj, op: JsonObj): JsonObj {
  const properties: JsonObj = {};
  const required: string[] = [];
  const params = [
    ...((pathItem["parameters"] as JsonObj[] | undefined) ?? []),
    ...((op["parameters"] as JsonObj[] | undefined) ?? []),
  ].map((p) => resolveRefs(doc, p) as JsonObj);
  for (const p of params) {
    const pname = p["name"];
    if (typeof pname !== "string") continue;
    const schema = (p["schema"] as JsonObj | undefined) ?? { type: "string" };
    properties[pname] = { ...schema, ...(typeof p["description"] === "string" ? { description: p["description"] } : {}) };
    if (p["required"] === true) required.push(pname);
  }
  const body = ((op["requestBody"] as JsonObj | undefined)?.["content"] as JsonObj | undefined)?.["application/json"] as
    | JsonObj
    | undefined;
  if (body?.["schema"]) {
    properties["body"] = resolveRefs(doc, body["schema"]) as JsonObj;
    required.push("body");
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}
```

- [ ] **Step 5: Run** — PASS
- [ ] **Step 6: Commit** — `git commit -am "feat(cli): openapi to tools.json conversion with annotation rules"`

---

### Task 11: LLM helper (`llm.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/llm.ts`
- Test: `packages/flowlet-cli/src/llm.test.ts`

- [ ] **Step 1: Failing test** (MockLanguageModelV3, mirroring `natural-language.test.ts` usage)

```ts
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { generateJson } from "./llm.js";

const schema = z.object({ ok: z.boolean() });

function textModel(responses: string[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      content: [{ type: "text" as const, text: responses[Math.min(i++, responses.length - 1)]! }],
      warnings: [],
    }),
  });
}

describe("generateJson", () => {
  it("parses fenced JSON", async () => {
    const model = textModel(['```json\n{"ok": true}\n```']);
    expect(await generateJson({ model, schema, prompt: "x" })).toEqual({ ok: true });
  });

  it("retries once with the validation error, then throws", async () => {
    const model = textModel(["not json", "still not json"]);
    await expect(generateJson({ model, schema, prompt: "x" })).rejects.toThrow(/after retry/);
  });

  it("recovers on the retry", async () => {
    const model = textModel(["nope", '{"ok": false}']);
    expect(await generateJson({ model, schema, prompt: "x" })).toEqual({ ok: false });
  });
});
```

(If `MockLanguageModelV3`'s `doGenerate` result shape differs in ai 6.0.28, copy the exact shape from `packages/flowlet-agent/src/policy/natural-language.test.ts` — it is the working precedent.)

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/llm.ts`**

```ts
/**
 * LLM plumbing for the CLI's assisted extractors.
 *
 * Uses generateText + zod-parse (NOT generateObject) so MockLanguageModelV3
 * can drive unit tests — same precedent as flowlet-agent's natural-language
 * policy judge.
 */
import { generateText, type LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";

/** Same default as demo-bank's DEMO_MODEL; override via FLOWLET_CLI_MODEL. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Returns null when no ANTHROPIC_API_KEY is present — callers skip LLM steps. */
export function cliModel(): LanguageModel | null {
  if (!process.env["ANTHROPIC_API_KEY"]) return null;
  return anthropic(process.env["FLOWLET_CLI_MODEL"] ?? DEFAULT_MODEL);
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json|typescript|tsx)?\s*([\s\S]*?)```/);
  return (m?.[1] ?? text).trim();
}

export async function generateJson<T>(opts: {
  model: LanguageModel;
  schema: z.ZodType<T>;
  prompt: string;
}): Promise<T> {
  const ask = async (prompt: string): Promise<{ value?: T; error: string }> => {
    const { text } = await generateText({ model: opts.model, prompt });
    try {
      return { value: opts.schema.parse(JSON.parse(stripFences(text))), error: "" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const first = await ask(opts.prompt);
  if (first.value !== undefined) return first.value;
  const second = await ask(
    `${opts.prompt}\n\nYour previous response failed to parse: ${first.error}\nRespond with ONLY valid JSON matching the requested shape.`,
  );
  if (second.value !== undefined) return second.value;
  throw new Error(`LLM output failed validation after retry: ${second.error}`);
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): generateText+zod LLM helper with single retry"`

---

### Task 12: Next.js route-scan fallback (`tools/route-scan.ts`)

Used only when no OpenAPI spec is found (demo-bank's case). Enabled by architecture Decision 3, which lists "route scan" as a tools.json source; flagged in findings since the session scope named OpenAPI as primary.

**Files:**
- Create: `packages/flowlet-cli/src/tools/route-scan.ts`
- Test: `packages/flowlet-cli/src/tools/route-scan.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { scanRoutes } from "./route-scan.js";

const ROUTE = `
import { ok } from "@/server/http";
import { listTransactions } from "@/server/transactions";
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 40);
  return ok(listTransactions({ limit }));
}
`;

const LLM_REPLY = JSON.stringify([{
  name: "list_transactions",
  description: "List recent transactions with an optional limit.",
  method: "get",
  path: "/api/transactions",
  inputSchema: { type: "object", properties: { limit: { type: "integer", description: "Max rows (default 40)" } } },
}]);

function model(reply: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      content: [{ type: "text" as const, text: reply }],
      warnings: [],
    }),
  });
}

describe("scanRoutes", () => {
  it("finds route.ts files and converts LLM output to tool entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE);
    const tools = await scanRoutes(dir, model(LLM_REPLY));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "list_transactions",
      source: "route-scan",
      http: { method: "get", path: "/api/transactions" },
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
  });

  it("returns [] when there are no route files (no LLM call)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    const tools = await scanRoutes(dir, model("[]"));
    expect(tools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/tools/route-scan.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { walk } from "../fsx.js";
import { generateJson } from "../llm.js";
import { annotationsFor, type ToolEntry } from "./manifest.js";

const routeToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  method: z.enum(["get", "post", "put", "patch", "delete"]),
  path: z.string().startsWith("/"),
  inputSchema: z.record(z.unknown()),
});
const routeToolsSchema = z.array(routeToolSchema);

function urlPathFor(routeFile: string, targetDir: string): string {
  // src/app/api/transactions/[id]/route.ts -> /api/transactions/{id}
  const rel = path.relative(targetDir, routeFile).replace(/\\/g, "/");
  const inApp = rel.replace(/^(src\/)?app/, "").replace(/\/route\.tsx?$/, "");
  return inApp.replace(/\[([^\]]+)\]/g, "{$1}") || "/";
}

function buildPrompt(routes: Array<{ urlPath: string; source: string }>): string {
  return [
    "You are extracting an HTTP API surface as agent tool definitions.",
    "For EVERY exported HTTP method handler (GET/POST/PUT/PATCH/DELETE) in the files below,",
    "emit one tool entry. Rules:",
    '- name: snake_case verb_noun (e.g. "list_transactions", "create_payment").',
    "- description: 1-2 sentences a language model uses to decide when to call the tool;",
    "  describe behaviour, inputs, defaults, notable response fields.",
    "- method/path: the HTTP method (lowercase) and the URL path exactly as given per file.",
    "- inputSchema: JSON Schema object for query/path/body inputs the handler actually reads.",
    "",
    "Respond with ONLY a JSON array of entries:",
    '[{"name":"...","description":"...","method":"get","path":"/...","inputSchema":{...}}]',
    "",
    ...routes.map((r) => `--- path: ${r.urlPath} ---\n${r.source}`),
  ].join("\n");
}

export async function scanRoutes(targetDir: string, model: LanguageModel): Promise<ToolEntry[]> {
  const files = await walk(targetDir, (p) => /(^|\/)app\/api\/.*route\.tsx?$/.test(p.replace(/\\/g, "/")), 200);
  if (files.length === 0) return [];
  const routes = await Promise.all(
    files.map(async (f) => ({ urlPath: urlPathFor(f, targetDir), source: await fs.readFile(f, "utf8") })),
  );
  const raw = await generateJson({ model, schema: routeToolsSchema, prompt: buildPrompt(routes) });
  return raw.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: annotationsFor(t.method, t.name),
    http: { method: t.method, path: t.path },
    source: "route-scan" as const,
  }));
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): LLM route-scan fallback for hosts without OpenAPI"`

---

### Task 13: Tools extraction orchestrator (`tools/extract-tools.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/tools/extract-tools.ts`
- Test: `packages/flowlet-cli/src/tools/extract-tools.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTools } from "./extract-tools.js";

const fixture = path.join(fileURLToPath(new URL(".", import.meta.url)), "../../test/fixtures/openapi/maple.json");

describe("extractTools", () => {
  it("prefers OpenAPI when present and writes a valid manifest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tools-"));
    await copyFile(fixture, path.join(dir, "openapi.json"));
    const summary = await extractTools(dir, { openapiPath: path.join(dir, "openapi.json") }, null, { force: false });
    const manifest = JSON.parse(await readFile(path.join(dir, ".flowlet/tools.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.tools.length).toBe(4);
    expect(manifest.events).toEqual([]);
    expect(summary.source).toBe("openapi");
  });

  it("reports skipped when no spec and no model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tools-"));
    const summary = await extractTools(dir, { openapiPath: null }, null, { force: false });
    expect(summary.source).toBe("none");
    expect(summary.toolCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/tools/extract-tools.ts`**

```ts
import path from "node:path";
import type { LanguageModel } from "ai";
import { writeGenerated } from "../fsx.js";
import { convertOpenApi } from "./openapi.js";
import { scanRoutes } from "./route-scan.js";
import { toolsManifestSchema, type ToolsManifest } from "./manifest.js";

export interface ToolsSummary {
  source: "openapi" | "route-scan" | "none";
  toolCount: number;
  errors: string[];
}

export async function extractTools(
  targetDir: string,
  info: { openapiPath: string | null },
  model: LanguageModel | null,
  opts: { force: boolean },
): Promise<ToolsSummary> {
  const errors: string[] = [];
  let manifest: ToolsManifest | null = null;
  let source: ToolsSummary["source"] = "none";

  if (info.openapiPath) {
    const tools = await convertOpenApi(info.openapiPath);
    manifest = {
      version: 1,
      extractedFrom: { kind: "openapi", path: path.relative(targetDir, info.openapiPath) },
      tools,
      events: [],
    };
    source = "openapi";
  } else if (model) {
    const tools = await scanRoutes(targetDir, model);
    if (tools.length > 0) {
      manifest = { version: 1, extractedFrom: { kind: "route-scan", path: "app/api/**/route.ts" }, tools, events: [] };
      source = "route-scan";
    } else {
      errors.push("no OpenAPI spec and no scannable routes found — write .flowlet/tools.json by hand");
    }
  } else {
    errors.push("no OpenAPI spec found and LLM unavailable (set ANTHROPIC_API_KEY) — tools.json skipped");
  }

  if (manifest) {
    const valid = toolsManifestSchema.parse(manifest); // never emit an invalid artifact
    await writeGenerated(path.join(targetDir, ".flowlet/tools.json"), JSON.stringify(valid, null, 2) + "\n", opts);
  }
  return { source, toolCount: manifest?.tools.length ?? 0, errors };
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): tools.json extraction pipeline (openapi primary, route-scan fallback)"`

---

### Task 14: Component candidate scanner (`components/scan.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/components/scan.ts`
- Test: `packages/flowlet-cli/src/components/scan.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanComponents } from "./scan.js";

describe("scanComponents", () => {
  it("finds exported PascalCase components under components dirs, skipping tests/pages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scan-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await mkdir(path.join(dir, "src/app"), { recursive: true });
    await writeFile(path.join(dir, "src/components/ui/button.tsx"), "export function Button() { return null }");
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    await writeFile(path.join(dir, "src/components/ui/button.test.tsx"), "export function ButtonTest() {}");
    await writeFile(path.join(dir, "src/components/ui/helpers.ts"), "export const x = 1"); // not .tsx
    await writeFile(path.join(dir, "src/app/page.tsx"), "export default function Page() { return null }");
    const candidates = await scanComponents(dir);
    expect(candidates.map((c) => c.exportName).sort()).toEqual(["Badge", "Button"]);
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/components/scan.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "../fsx.js";

export interface ComponentCandidate {
  /** absolute path to the source file */
  file: string;
  /** path relative to the target root, forward slashes */
  relFile: string;
  /** first exported PascalCase symbol (the analysis prompt sees the whole file) */
  exportName: string;
  source: string;
}

const EXPORT_RE = /export\s+(?:function|const)\s+([A-Z][A-Za-z0-9]*)/;
const MAX_CANDIDATES = 25;
const MAX_FILE_BYTES = 40_000;

export async function scanComponents(targetDir: string): Promise<ComponentCandidate[]> {
  const files = await walk(
    targetDir,
    (p) => {
      const rel = p.replace(/\\/g, "/");
      return (
        /(^|\/)components\//.test(rel) &&
        rel.endsWith(".tsx") &&
        !/\.(test|spec|stories)\.tsx$/.test(rel)
      );
    },
    2_000,
  );
  const candidates: ComponentCandidate[] = [];
  for (const file of files) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const source = await fs.readFile(file, "utf8");
    if (source.length > MAX_FILE_BYTES) continue; // giant files are not reusable primitives
    const m = source.match(EXPORT_RE);
    if (!m || !m[1]) continue;
    candidates.push({ file, relFile: path.relative(targetDir, file).replace(/\\/g, "/"), exportName: m[1], source });
  }
  return candidates;
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): host component candidate scanner"`

---

### Task 15: Component analysis + codegen (`components/analyze.ts`, `components/codegen.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/components/analyze.ts`, `src/components/codegen.ts`
- Test: `packages/flowlet-cli/src/components/analyze.test.ts`, `src/components/codegen.test.ts`

- [ ] **Step 1: Implement `src/components/analyze.ts`** (schema + prompt; test with mock below)

```ts
import { z } from "zod";
import type { LanguageModel } from "ai";
import { generateJson } from "../llm.js";
import type { ComponentCandidate } from "./scan.js";

export const propSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  type: z.enum(["string", "number", "boolean", "string[]", "number[]", "enum"]),
  enumValues: z.array(z.string()).optional(),
  optional: z.boolean(),
  description: z.string().min(1),
});

export const componentAnalysisSchema = z.object({
  include: z.boolean(),
  reason: z.string(),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  description: z.string(),
  /** Named exports to import from the host file (e.g. ["Button"]). */
  imports: z.array(z.string()),
  props: z.array(propSpecSchema),
  /** A single JSX expression using `p` (parsed props) and the imported names. */
  jsx: z.string(),
});
export type ComponentAnalysis = z.infer<typeof componentAnalysisSchema>;

function buildPrompt(c: ComponentCandidate): string {
  return [
    "You are wrapping a host React component so a sandboxed generated-UI runtime can render it.",
    "The sandbox renders components from JSON props only. Decide whether this component is a",
    "reusable presentational primitive worth exposing, and if so emit its wrapper spec.",
    "",
    "Hard rules:",
    "- include=false for pages, layouts, providers, portals/toasts, or components needing",
    "  callbacks, context, refs, ReactNode props, or data fetching to be useful.",
    "- props: JSON-serializable only (string/number/boolean/arrays/enum). Map ReactNode-ish",
    '  slots to strings (e.g. children -> a "text" string prop).',
    "- description: 1-2 sentences that help a language model decide when to pick this component.",
    "- jsx: ONE JSX expression using `p` for parsed props and ONLY the names in `imports`.",
    "  No hooks, no window/document, no new dependencies, no event handlers.",
    "",
    "Respond with ONLY JSON:",
    '{"include":bool,"reason":"...","name":"PascalCase","description":"...",',
    ' "imports":["..."],"props":[{"name":"...","type":"string","optional":false,"description":"..."}],',
    ' "jsx":"<Button variant={p.variant}>{p.label}</Button>"}',
    "",
    `--- ${c.relFile} ---`,
    c.source,
  ].join("\n");
}

export async function analyzeComponent(c: ComponentCandidate, model: LanguageModel): Promise<ComponentAnalysis> {
  return generateJson({ model, schema: componentAnalysisSchema, prompt: buildPrompt(c) });
}
```

- [ ] **Step 2: Implement `src/components/codegen.ts`**

```ts
import path from "node:path";
import { transform } from "sucrase";
import { writeGenerated } from "../fsx.js";
import type { ComponentAnalysis, ComponentAnalysis as Analysis } from "./analyze.js";
import type { ComponentCandidate } from "./scan.js";

/** Names already taken by the prewired library — generated hosts get a Host prefix. */
const PREWIRED_NAMES = new Set([
  "Card", "Table", "Chart", "Form", "Accordion", "Carousel", "Callout", "Tags",
  "Steps", "List", "Image", "ImageGallery", "Markdown", "CodeBlock", "Tabs", "TimeOfDayClock",
]);

export function registryName(analysis: Analysis): string {
  return PREWIRED_NAMES.has(analysis.name) ? `Host${analysis.name}` : analysis.name;
}

function camel(name: string): string {
  return name[0]!.toLowerCase() + name.slice(1);
}

export function zodSource(props: Analysis["props"]): string {
  const fields = props.map((p) => {
    let expr =
      p.type === "string" ? "z.string()"
      : p.type === "number" ? "z.number()"
      : p.type === "boolean" ? "z.boolean()"
      : p.type === "string[]" ? "z.array(z.string())"
      : p.type === "number[]" ? "z.array(z.number())"
      : `z.enum([${(p.enumValues ?? []).map((v) => JSON.stringify(v)).join(", ")}])`;
    if (p.optional) expr += ".optional()";
    expr += `.describe(${JSON.stringify(p.description)})`;
    return `  ${p.name}: ${expr},`;
  });
  return `z.object({\n${fields.join("\n")}\n})`;
}

export function descriptorSource(analysis: Analysis): string {
  const name = registryName(analysis);
  const c = camel(name);
  return `/**
 * Generated by \`flowlet init\` — review and edit freely; this file is yours.
 */
import { z } from "zod";
import type { RegisteredComponent, FlowletSchema } from "@flowlet/core";

export const ${c}Schema = ${zodSource(analysis.props)};

export const ${c}Descriptor: RegisteredComponent = {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(analysis.description)},
  propsSchema: ${c}Schema as FlowletSchema<unknown>,
  source: "host",
};
`;
}

export function implSource(analysis: Analysis, candidate: ComponentCandidate): string {
  const name = registryName(analysis);
  const c = camel(name);
  // .flowlet/components/<Name>/impl.tsx -> host file, so hop out three levels.
  const importPath = path.posix
    .join("../../..", candidate.relFile)
    .replace(/\.tsx?$/, "");
  return `/**
 * Generated by \`flowlet init\` — wraps ${candidate.relFile} for the Flowlet sandbox.
 * Review and edit freely; this file is yours.
 */
import { ${analysis.imports.join(", ")} } from "${importPath}";
import { ${c}Schema } from "./descriptor";

export function ${name}(props: Record<string, unknown>) {
  const parsed = ${c}Schema.safeParse(props);
  if (!parsed.success) {
    return <div data-testid="flowlet-invalid-props">Invalid component props</div>;
  }
  const p = parsed.data;
  return ${analysis.jsx};
}
`;
}

export function entrySource(names: string[]): string {
  const imports = names.map((n) => `import { ${n} } from "./${n}/impl";`).join("\n");
  return `/**
 * Generated by \`flowlet init\`. Sandbox host bundle entry: exposes wrapped host
 * components to the Flowlet stage runtime (window.__FLOWLET_HOST__ contract —
 * see packages/flowlet-components/bundle/entry.ts for the reference bundle).
 * NOTE: merging these with the prewired bundle is host wiring (ENG-186/ENG-202).
 */
import React from "react";
import { createRoot } from "react-dom/client";
${imports}

declare global {
  interface Window {
    __React: typeof React;
    __createRoot: typeof createRoot;
    __FLOWLET_HOST__: Record<string, unknown>;
  }
}

window.__React = React;
window.__createRoot = createRoot;
window.__FLOWLET_HOST__ = { ${names.join(", ")} };
`;
}

export function viteConfigSource(): string {
  return `/** Generated by \`flowlet init\`. Builds the host-component sandbox bundle. */
import { flowletHostPreset } from "@flowlet/stage/build";

export default flowletHostPreset({ entry: "entry.ts", version: "0.0.1" });
`;
}

/** Throws with the sucrase error message when the generated TSX does not parse. */
export function assertParses(fileLabel: string, source: string): void {
  try {
    transform(source, { transforms: ["typescript", "jsx"] });
  } catch (err) {
    throw new Error(`generated ${fileLabel} has a syntax error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeComponent(
  targetDir: string,
  analysis: ComponentAnalysis,
  candidate: ComponentCandidate,
  opts: { force: boolean },
): Promise<string> {
  const name = registryName(analysis);
  const descriptor = descriptorSource(analysis);
  const impl = implSource(analysis, candidate);
  assertParses(`${name}/descriptor.ts`, descriptor);
  assertParses(`${name}/impl.tsx`, impl);
  const base = path.join(targetDir, ".flowlet/components", name);
  await writeGenerated(path.join(base, "descriptor.ts"), descriptor, opts);
  await writeGenerated(path.join(base, "impl.tsx"), impl, opts);
  return name;
}
```

- [ ] **Step 3: Failing tests**

`src/components/codegen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { descriptorSource, implSource, entrySource, registryName, assertParses } from "./codegen.js";
import type { ComponentAnalysis } from "./analyze.js";
import type { ComponentCandidate } from "./scan.js";

const analysis: ComponentAnalysis = {
  include: true,
  reason: "reusable primitive",
  name: "Button",
  description: "A styled button with variants.",
  imports: ["Button"],
  props: [
    { name: "label", type: "string", optional: false, description: "Button text." },
    { name: "variant", type: "enum", enumValues: ["primary", "ghost"], optional: true, description: "Visual style." },
  ],
  jsx: "<Button variant={p.variant}>{p.label}</Button>",
};
const candidate: ComponentCandidate = {
  file: "/x/src/components/ui/button.tsx",
  relFile: "src/components/ui/button.tsx",
  exportName: "Button",
  source: "",
};

describe("codegen", () => {
  it("emits a descriptor matching RegisteredComponent with source host", () => {
    const src = descriptorSource(analysis);
    expect(src).toContain('source: "host"');
    expect(src).toContain('z.enum(["primary", "ghost"])');
    assertParses("descriptor", src);
  });

  it("emits a wrapper that imports the host file relatively and safeParses props", () => {
    const src = implSource(analysis, candidate);
    expect(src).toContain('from "../../../src/components/ui/button"');
    expect(src).toContain("safeParse");
    assertParses("impl", src);
  });

  it("prefixes names that collide with prewired components", () => {
    expect(registryName({ ...analysis, name: "Card" })).toBe("HostCard");
    expect(registryName(analysis)).toBe("Button");
  });

  it("rejects broken generated JSX", () => {
    expect(() => assertParses("impl", "const x = <div>")).toThrow(/syntax error/);
  });

  it("entry source wires the __FLOWLET_HOST__ contract", () => {
    const src = entrySource(["Button"]);
    expect(src).toContain("window.__FLOWLET_HOST__ = { Button }");
    assertParses("entry", src);
  });
});
```

`src/components/analyze.test.ts` (mock model; also proves invalid JSX from the LLM surfaces as an error at write time — covered by codegen test, so here just parse-shape):

```ts
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { analyzeComponent } from "./analyze.js";

const REPLY = JSON.stringify({
  include: true, reason: "primitive", name: "Badge", description: "A small status badge.",
  imports: ["Badge"],
  props: [{ name: "text", type: "string", optional: false, description: "Badge text." }],
  jsx: "<Badge>{p.text}</Badge>",
});

describe("analyzeComponent", () => {
  it("returns a validated analysis", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text" as const, text: REPLY }],
        warnings: [],
      }),
    });
    const a = await analyzeComponent(
      { file: "/x/badge.tsx", relFile: "src/components/ui/badge.tsx", exportName: "Badge", source: "export const Badge = () => null" },
      model,
    );
    expect(a.name).toBe("Badge");
    expect(a.include).toBe(true);
  });
});
```

- [ ] **Step 4: Run** — `pnpm --filter @flowlet/cli test -- components` → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): LLM component analysis and descriptor/wrapper codegen"`

---

### Task 16: Components orchestrator (`components/extract-components.ts`)

**Files:**
- Create: `packages/flowlet-cli/src/components/extract-components.ts`
- Test: `packages/flowlet-cli/src/components/extract-components.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { extractComponents } from "./extract-components.js";

const INCLUDE = JSON.stringify({
  include: true, reason: "primitive", name: "Badge", description: "A small status badge.",
  imports: ["Badge"], props: [{ name: "text", type: "string", optional: false, description: "Badge text." }],
  jsx: "<Badge>{p.text}</Badge>",
});
const EXCLUDE = JSON.stringify({
  include: false, reason: "page-level", name: "Page", description: "n/a", imports: [], props: [], jsx: "<div />",
});

describe("extractComponents", () => {
  it("writes descriptor/impl pairs for included components plus entry + vite config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "comp-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    await writeFile(path.join(dir, "src/components/ui/panel.tsx"), "export const Panel = () => null");
    const replies = [INCLUDE, EXCLUDE];
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text" as const, text: replies[Math.min(i++, replies.length - 1)]! }],
        warnings: [],
      }),
    });
    const summary = await extractComponents(dir, model, { force: false });
    expect(summary.written).toEqual(["Badge"]);
    expect(summary.excluded).toHaveLength(1);
    await readFile(path.join(dir, ".flowlet/components/Badge/descriptor.ts"), "utf8");
    await readFile(path.join(dir, ".flowlet/components/Badge/impl.tsx"), "utf8");
    await readFile(path.join(dir, ".flowlet/components/entry.ts"), "utf8");
    await readFile(path.join(dir, ".flowlet/components/vite.config.ts"), "utf8");
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/components/extract-components.ts`**

```ts
import path from "node:path";
import type { LanguageModel } from "ai";
import { writeGenerated } from "../fsx.js";
import { scanComponents } from "./scan.js";
import { analyzeComponent } from "./analyze.js";
import { writeComponent, entrySource, viteConfigSource } from "./codegen.js";

export interface ComponentsSummary {
  candidates: number;
  written: string[];
  excluded: Array<{ file: string; reason: string }>;
  failed: Array<{ file: string; error: string }>;
}

export async function extractComponents(
  targetDir: string,
  model: LanguageModel,
  opts: { force: boolean },
): Promise<ComponentsSummary> {
  const candidates = await scanComponents(targetDir);
  const written: string[] = [];
  const excluded: ComponentsSummary["excluded"] = [];
  const failed: ComponentsSummary["failed"] = [];

  for (const candidate of candidates) {
    try {
      const analysis = await analyzeComponent(candidate, model);
      if (!analysis.include) {
        excluded.push({ file: candidate.relFile, reason: analysis.reason });
        continue;
      }
      written.push(await writeComponent(targetDir, analysis, candidate, opts));
    } catch (err) {
      failed.push({ file: candidate.relFile, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (written.length > 0) {
    await writeGenerated(path.join(targetDir, ".flowlet/components/entry.ts"), entrySource(written), opts);
    await writeGenerated(path.join(targetDir, ".flowlet/components/vite.config.ts"), viteConfigSource(), opts);
  }
  return { candidates: candidates.length, written, excluded, failed };
}
```

- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): component extraction pipeline writing .flowlet/components/"`

---

### Task 17: `flowlet init` orchestrator + report + README emission

**Files:**
- Create: `packages/flowlet-cli/src/init.ts`, `src/report.ts`
- Test: `packages/flowlet-cli/src/init.test.ts`

- [ ] **Step 1: Implement `src/report.ts`**

```ts
import type { FrameworkInfo } from "./detect.js";
import type { ThemeSummary } from "./theme/extract-theme.js";
import type { ToolsSummary } from "./tools/extract-tools.js";
import type { ComponentsSummary } from "./components/extract-components.js";

export interface InitReport {
  info: FrameworkInfo;
  theme: ThemeSummary | null;
  tools: ToolsSummary | null;
  components: ComponentsSummary | null;
  llmSkipped: boolean;
}

export function renderReport(r: InitReport): string {
  const lines: string[] = [];
  lines.push(`framework: ${r.info.framework}   tailwind: ${r.info.tailwind}   openapi: ${r.info.openapiPath ?? "none"}`);
  if (r.theme) {
    lines.push(`theme.json: ${r.theme.written ? "written" : "SKIPPED"} (${r.theme.varCount} vars scanned)`);
    for (const [slot, v] of Object.entries(r.theme.matched)) lines.push(`  ${slot} <- ${v}`);
    if (r.theme.defaulted.length > 0) lines.push(`  DEFAULTED (edit by hand): ${r.theme.defaulted.join(", ")}`);
    if (r.theme.hasDarkVariant) lines.push("  note: dark-scoped vars exist; BrandTokens holds one mode — see .flowlet/README.md");
    for (const e of r.theme.errors) lines.push(`  warning: ${e}`);
  }
  if (r.tools) {
    lines.push(`tools.json: ${r.tools.toolCount} tools (source: ${r.tools.source})`);
    for (const e of r.tools.errors) lines.push(`  warning: ${e}`);
  }
  if (r.components) {
    lines.push(`components/: ${r.components.written.length}/${r.components.candidates} candidates wrapped`);
    for (const x of r.components.excluded) lines.push(`  excluded ${x.file}: ${x.reason}`);
    for (const f of r.components.failed) lines.push(`  FAILED ${f.file}: ${f.error}`);
  }
  if (r.llmSkipped) lines.push("LLM steps skipped (no ANTHROPIC_API_KEY or --skip-llm): route-scan fallback, component discovery");
  lines.push("All output is in .flowlet/ — review and edit it; nothing else in your repo was touched.");
  return lines.join("\n");
}
```

- [ ] **Step 2: Implement `src/init.ts`**

```ts
import path from "node:path";
import { detectTarget } from "./detect.js";
import { extractTheme } from "./theme/extract-theme.js";
import { extractTools } from "./tools/extract-tools.js";
import { extractComponents } from "./components/extract-components.js";
import { cliModel } from "./llm.js";
import { renderReport, type InitReport } from "./report.js";
import { writeGenerated } from "./fsx.js";
import type { LanguageModel } from "ai";

export interface InitOptions {
  targetDir: string;
  skipLlm: boolean;
  force: boolean;
  /** test seam */
  model?: LanguageModel | null;
}

function readmeSource(report: InitReport): string {
  return `# .flowlet/ — generated by \`flowlet init\`

Everything in this directory is **yours to edit and commit**. \`flowlet init\` never
modifies existing code; re-running it refuses to overwrite these files unless you
pass \`--force\`.

- \`theme.json\` — BrandTokens consumed by the Flowlet sandbox theme injection.
  One mode per file today${report.theme?.hasDarkVariant ? " (dark-scoped variables were detected but not emitted — open schema question)" : ""}.
- \`tools.json\` — your API surface as tool descriptors. \`annotations\` uses MCP-style
  hints: \`readOnlyHint: false\` means mutating, \`destructiveHint: true\` means dangerous
  (approval-gated by the Flowlet policy layer). \`inputSchema\` convention: path/query
  params are top-level properties; a JSON request body is the \`body\` property.
  \`events\` declares host event types usable as automation triggers (empty until you add them).
- \`components/\` — descriptor + sandbox wrapper pairs around your components, plus an
  \`entry.ts\`/\`vite.config.ts\` that build them into a sandbox bundle with
  \`flowletHostPreset\`. Wiring the bundle into a running Flowlet host is separate
  (see ENG-186/ENG-202).

\`flowlet publish\` uploads tools.json to the Flowlet registry — stubbed until the
registry ships (ENG-198). Embedded hosts read this directory from disk.
`;
}

export async function runInit(opts: InitOptions): Promise<number> {
  const targetDir = path.resolve(opts.targetDir);
  const info = await detectTarget(targetDir);
  const model = opts.skipLlm ? null : opts.model !== undefined ? opts.model : cliModel();

  const report: InitReport = { info, theme: null, tools: null, components: null, llmSkipped: model === null };
  try {
    report.theme = await extractTheme(targetDir, info, opts);
    report.tools = await extractTools(targetDir, info, model, opts);
    if (model) report.components = await extractComponents(targetDir, model, opts);
    await writeGenerated(path.join(targetDir, ".flowlet/README.md"), readmeSource(report), opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.log(renderReport(report));
  return 0;
}
```

- [ ] **Step 3: Failing e2e test** — `src/init.test.ts` builds the mini fixture app inline (same shape as detect/extract tests, all three extractors exercised through `main`-level `runInit` with a mock model):

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { runInit } from "./init.js";

const ROUTE_REPLY = JSON.stringify([{
  name: "list_things", description: "List things.", method: "get", path: "/api/things",
  inputSchema: { type: "object", properties: {} },
}]);
const COMPONENT_REPLY = JSON.stringify({
  include: true, reason: "primitive", name: "Badge", description: "A badge.",
  imports: ["Badge"], props: [{ name: "text", type: "string", optional: false, description: "Text." }],
  jsx: "<Badge>{p.text}</Badge>",
});

describe("runInit e2e (mock model)", () => {
  it("emits all three artifacts + README into .flowlet only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "src/app/api/things"), { recursive: true });
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(path.join(dir, "src/app/globals.css"), "@theme { --color-bg: #ffffff; --color-ink: #111111; }");
    await writeFile(path.join(dir, "src/app/api/things/route.ts"), "export async function GET() {}");
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");

    const replies = [ROUTE_REPLY, COMPONENT_REPLY];
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text" as const, text: replies[Math.min(i++, replies.length - 1)]! }],
        warnings: [],
      }),
    });

    const code = await runInit({ targetDir: dir, skipLlm: false, force: false, model });
    expect(code).toBe(0);
    const theme = JSON.parse(await readFile(path.join(dir, ".flowlet/theme.json"), "utf8"));
    expect(theme.background).toBe("#ffffff");
    const tools = JSON.parse(await readFile(path.join(dir, ".flowlet/tools.json"), "utf8"));
    expect(tools.tools[0].name).toBe("list_things");
    await readFile(path.join(dir, ".flowlet/components/Badge/impl.tsx"), "utf8");
    await readFile(path.join(dir, ".flowlet/README.md"), "utf8");
  });

  it("--skip-llm still writes theme.json and reports skips", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "init-"));
    await writeFile(path.join(dir, "package.json"), "{}");
    await writeFile(path.join(dir, "globals.css"), ":root { --color-bg: #ffffff; }");
    const code = await runInit({ targetDir: dir, skipLlm: true, force: false });
    expect(code).toBe(0);
    await readFile(path.join(dir, ".flowlet/theme.json"), "utf8");
  });
});
```

- [ ] **Step 4: Run** — `pnpm --filter @flowlet/cli test` → ALL PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): flowlet init orchestrator, report, and .flowlet README"`

---

### Task 18: `flowlet publish` stub

**Files:**
- Create: `packages/flowlet-cli/src/publish.ts`
- Test: `packages/flowlet-cli/src/publish.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPublish } from "./publish.js";

describe("runPublish (stub)", () => {
  it("validates the manifest, prints its hash, and explains the stub", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pub-"));
    await mkdir(path.join(dir, ".flowlet"));
    await writeFile(path.join(dir, ".flowlet/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runPublish({ targetDir: dir })).toBe(0);
    const out = log.mock.calls.flat().join("\n");
    expect(out).toMatch(/sha256:[0-9a-f]{64}/);
    expect(out).toMatch(/ENG-198|registry/i);
    log.mockRestore();
  });

  it("fails when .flowlet/tools.json is missing or invalid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pub-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runPublish({ targetDir: dir })).toBe(1);
  });
});
```

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement `src/publish.ts`**

```ts
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { toolsManifestSchema } from "./tools/manifest.js";

/**
 * `flowlet publish` — STUB. The cloud manifest registry is ENG-198 (track A);
 * this validates the manifest and computes the content hash a real publish
 * would be keyed by. Embedded mode reads .flowlet/ from disk and never needs it.
 */
export async function runPublish(opts: { targetDir: string }): Promise<number> {
  const manifestPath = path.join(path.resolve(opts.targetDir), ".flowlet/tools.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    toolsManifestSchema.parse(manifest);
  } catch (err) {
    console.error(`cannot publish: ${manifestPath} missing or invalid — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  console.log(
    [
      `manifest valid — sha256:${hash}`,
      "publish is a stub: the cloud registry lands with ENG-198.",
      "When it ships, this command uploads the manifest (tenant + version + hash) and sessions bind to it.",
      "Embedded hosts read .flowlet/ from disk; publish stays a no-op there.",
    ].join("\n"),
  );
  return 0;
}
```

- [ ] **Step 4: Run** — PASS. Also run full suite + `pnpm build && pnpm typecheck && pnpm lint` at root.
- [ ] **Step 5: Commit** — `git commit -am "feat(cli): publish stub — validate manifest, print content hash"`

---

### Task 19: Ground truth — run against `apps/demo-bank`, commit output, write findings

**Files:**
- Create (generated): `apps/demo-bank/.flowlet/**`
- Create: `docs/superpowers/specs/2026-07-02-flowlet-eng197-extraction-fidelity-findings.md`

- [ ] **Step 1: Build and run for real** (LLM steps need the key demo-bank already uses)

```bash
pnpm build
infisical run --projectId=b366cac7-1716-47a0-9617-f335500f6dee --env=dev -- \
  node packages/flowlet-cli/dist/cli.js init apps/demo-bank
```

Expected: report printed; `apps/demo-bank/.flowlet/{theme.json,tools.json,components/,README.md}` created; `git status` shows ONLY new files under `apps/demo-bank/.flowlet/` (the never-modify guarantee, verified).

- [ ] **Step 2: Verify generated components compile**

```bash
cd apps/demo-bank && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20 && cd ../..
```

`.flowlet` is inside demo-bank's tsconfig include? If demo-bank's tsconfig excludes it, typecheck the generated files directly: `npx tsc --noEmit --jsx react-jsx --strict --esModuleInterop --skipLibCheck apps/demo-bank/.flowlet/components/*/{descriptor.ts,impl.tsx}` (with workspace `@flowlet/core` + `zod` resolvable from the repo root). Record any errors verbatim in the findings — do NOT silently fix generated output; if a fix is needed, hand-edit and document the edit as an extraction-fidelity gap.

- [ ] **Step 3: Diff against the hand-written artifacts**

- Theme: `apps/demo-bank/.flowlet/theme.json` vs `apps/demo-bank/src/flowlet/brand.ts` (`mapleBrand`). Expect at minimum: `accent` differs (no accent var in globals.css; mapleBrand uses graphite `#1B1C22`), `radius` differs (`14px` extracted vs `16px` hand-tuned), `background` differs (`#FBFBFA` css vs `#F4F3F0` hand-picked warm paper). Record each with the reason.
- Tools: `.flowlet/tools.json` (route-scan of `src/app/api/*`) vs `src/flowlet/tools.ts` (`get_transactions`, `set_rule`) and `policy.ts`. Note the structural gap: hand-written tools are in-process ai-SDK tools with `execute`; extracted tools are HTTP descriptors. Compare description quality for the transactions tool; note `set_rule` has no HTTP equivalent (it's agent-internal) — an honest extractor cannot find it.
- Components: `.flowlet/components/*` vs the prewired pattern (`packages/flowlet-components/src/components/*`). demo-bank has NO hand-written host wrappers, so fidelity here = compile + pattern conformance + manual review of a sample (Button, Badge, Card at minimum). Screenshot not required (nothing user-visible ships; wrappers are not wired into the running app in this session — that is ENG-186/202).

- [ ] **Step 4: Commit the ground-truth output**

```bash
git add apps/demo-bank/.flowlet
git commit -m "chore(demo-bank): commit flowlet init ground-truth output for ENG-197 fidelity diff"
```

- [ ] **Step 5: Write the findings doc** — `docs/superpowers/specs/2026-07-02-flowlet-eng197-extraction-fidelity-findings.md` with sections:

1. **What was run** (command, model, commit).
2. **Theme fidelity** — table: slot | extracted | hand-written (`mapleBrand`) | verdict/why.
3. **Tools fidelity** — per tool: extracted entry vs hand-written; annotation correctness vs `policy.ts` verb rules; what an integrator must hand-edit.
4. **Component fidelity** — candidates found/wrapped/excluded/failed; compile results; qualitative review; what needed hand-editing.
5. **What needed hand-editing** — consolidated honest list.
6. **Open schema questions for contracts-freeze** (route through the orchestrator):
   - tools.json top-level shape (`version`/`extractedFrom`/`events`) is CLI-draft, not frozen.
   - annotations: MCP hints (matches `ToolAnnotations`) vs explicit `mutating`/`dangerous` booleans — issue wording vs existing type.
   - `inputSchema` convention for HTTP tools (params top-level, `body` nested) — needs blessing.
   - theme.json is a single-mode `BrandTokens`; scope said "light/dark" but the frozen type holds one `mode` — dark variant emission needs a schema decision.
   - host `events` declaration shape (Decision 3/5) — emitted empty, shape unvalidated.
   - registry-name collision policy for host components (`Host` prefix) — codegen convention, needs blessing.
7. **Scope notes** — route-scan fallback built (Decision 3 lists it; session scope named OpenAPI primary — flag for orchestrator review); tRPC skipped (not cheap); `flowlet dev` not built; `publish` stubbed.

- [ ] **Step 6: Commit** — `git add docs/superpowers/specs/2026-07-02-flowlet-eng197-extraction-fidelity-findings.md && git commit -m "docs: ENG-197 extraction-fidelity findings + open schema questions"`

---

### Task 20: Docs sync, verification, PR

**Files:**
- Create: `packages/flowlet-cli/README.md` (short: commands, artifacts, env vars)
- Modify: `CLAUDE.md` (root) — add `flowlet init/publish` one-liner under Commands

- [ ] **Step 1: README + CLAUDE.md line**

`packages/flowlet-cli/README.md`: ~20 lines — what `init` extracts, the three artifacts, `--skip-llm`/`--force`, `ANTHROPIC_API_KEY`/`FLOWLET_CLI_MODEL`, publish-is-a-stub.
Root `CLAUDE.md` Commands section, add: `- node packages/flowlet-cli/dist/cli.js init <dir> — one-click extractor (ENG-197); publish is stubbed`

- [ ] **Step 2: Full verification** (verification-before-completion skill)

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```
Expected: all green. Re-run the demo-bank init with `--force` only if extractor code changed since Task 19.

- [ ] **Step 3: Update worktree comment**

```bash
orca worktree set --worktree active --comment "ENG-197: CLI + extractors done, demo-bank ground truth committed, findings written — opening PR"
```

- [ ] **Step 4: Open PR (never merge)** — base `main`, head `yousef/eng-197-one-click-dev-tool-extract-theme-components-api-surface-from`. Body: summary, artifact walkthrough, fidelity-findings link + inline copy of the open-schema-questions list, scope notes (route-scan flag, tRPC skipped, dev not built), test/verification evidence. Stop after opening — Yousef merges.

---

## Self-review notes

- Spec coverage: framework detection (T4), theme extraction Tailwind-config + CSS vars → BrandTokens (T5–T8), tools.json from OpenAPI with annotations + editable output (T9–T10, T13), tRPC consciously skipped (findings), LLM component discovery → registry-compatible descriptor+wrapper pairs (T14–T16), `.flowlet/`-only output with never-modify guarantee (T3 writer + T19 git-status check), publish stub (T18), demo-bank ground truth + honest findings (T19), PR + stop (T20). `flowlet dev` deliberately out.
- The route-scan fallback is the one scope-adjacent addition; it is grounded in binding Decision 3 and is flagged, not silent.
- Type consistency: `ToolEntry`/`annotationsFor` defined in T9 and used in T10/T12/T13; `CssVarDecl` defined in T5, consumed in T6/T7; `ComponentAnalysis` defined in T15 and consumed in T16; `runInit`/`runPublish` signatures match T2's cli.ts.
- Known risk: exact `MockLanguageModelV3.doGenerate` result shape and flowlet-agent's tsconfig details must be copied from the working repo files at implementation time if they differ from what is written here.
