import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectVendoState, deepEqual } from "./state.js";

/** Build a fixture app tree: { "src/app/page.tsx": "..." } */
function app(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vendo-state-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const EMPTY_FALLBACK = JSON.stringify({ version: 1, tools: [], events: [] });
const REAL_TOOLS = JSON.stringify({
  version: 1,
  tools: [{ name: "list_things", description: "List things.", method: "get", path: "/api/things", inputSchema: { type: "object", properties: {} } }],
  events: [],
});

const NEXT_LAYOUT = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`;

describe("deepEqual", () => {
  it("is true for structurally-identical objects regardless of key order", () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
  });
  it("is false when values differ", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});

describe("inspectVendoState", () => {
  it("reports everything absent on an empty app dir", async () => {
    const dir = app({ "package.json": "{}" });
    const state = await inspectVendoState(dir);
    expect(state.theme.exists).toBe(false);
    expect(state.tools).toEqual({ exists: false, status: "missing" });
    expect(state.components).toEqual([]);
    expect(state.remixAnchors).toEqual([]);
    expect(state.wired).toEqual({ appDir: null, routeFile: false, rootFile: false, wired: false });
  });

  it("detects theme.json alone", async () => {
    const dir = app({ ".vendo/theme.json": JSON.stringify({ version: 1 }) });
    const state = await inspectVendoState(dir);
    expect(state.theme.exists).toBe(true);
    expect(state.tools.exists).toBe(false);
  });

  it("classifies the exact fallback tools.json written by next-wiring step 0 as empty-fallback", async () => {
    const dir = app({ ".vendo/tools.json": EMPTY_FALLBACK });
    const state = await inspectVendoState(dir);
    expect(state.tools).toEqual({ exists: true, status: "empty-fallback" });
  });

  it("classifies the fallback shape as empty-fallback even with different key order", async () => {
    const dir = app({ ".vendo/tools.json": JSON.stringify({ events: [], version: 1, tools: [] }) });
    const state = await inspectVendoState(dir);
    expect(state.tools.status).toBe("empty-fallback");
  });

  it("classifies a real tools.json as real", async () => {
    const dir = app({ ".vendo/tools.json": REAL_TOOLS });
    const state = await inspectVendoState(dir);
    expect(state.tools).toEqual({ exists: true, status: "real" });
  });

  it("classifies a malformed (unparseable) tools.json as real — additive consumers keep it", async () => {
    const dir = app({ ".vendo/tools.json": "{ not json" });
    const state = await inspectVendoState(dir);
    expect(state.tools).toEqual({ exists: true, status: "real" });
  });

  it("lists component wrapper dirs that have both descriptor.ts and impl.tsx", async () => {
    const dir = app({
      ".vendo/components/Badge/descriptor.ts": "export const badgeSchema = {}",
      ".vendo/components/Badge/impl.tsx": "export function BadgeWrapper() { return null }",
      ".vendo/components/Incomplete/descriptor.ts": "export const incompleteSchema = {}",
      ".vendo/components/entry.ts": "// not a wrapper dir",
    });
    const state = await inspectVendoState(dir);
    expect(state.components).toEqual(["Badge"]);
  });

  it("finds a source file with a literal-id VendoRemix anchor", async () => {
    const dir = app({
      "src/app/page.tsx": `import { VendoRemix } from "@vendoai/shell"
export default function Page() {
  return <VendoRemix id="upcoming-deadlines"><DeadlineList /></VendoRemix>
}
`,
    });
    const state = await inspectVendoState(dir);
    expect(state.remixAnchors).toEqual([{ file: path.join("src", "app", "page.tsx"), ids: ["upcoming-deadlines"] }]);
  });

  it("finds a single-quoted literal-id VendoRemix anchor (capture.ts's AST walk accepts both quote styles)", async () => {
    const dir = app({
      "src/app/page.tsx": `import { VendoRemix } from '@vendoai/shell'
export default function Page() {
  return <VendoRemix id='upcoming-deadlines'><DeadlineList /></VendoRemix>
}
`,
    });
    const state = await inspectVendoState(dir);
    expect(state.remixAnchors).toEqual([{ file: path.join("src", "app", "page.tsx"), ids: ["upcoming-deadlines"] }]);
  });

  it("finds a dynamic-id VendoRemix anchor with an empty ids list", async () => {
    const dir = app({
      "src/app/page.tsx": `import { VendoRemix } from "@vendoai/shell"
export default function Page({ id }: { id: string }) {
  return <VendoRemix id={id}><div /></VendoRemix>
}
`,
    });
    const state = await inspectVendoState(dir);
    expect(state.remixAnchors).toEqual([{ file: path.join("src", "app", "page.tsx"), ids: [] }]);
  });

  it("reports a fully wired app (route file + vendo-root present under src/app)", async () => {
    const dir = app({
      "src/app/layout.tsx": NEXT_LAYOUT,
      "src/app/api/vendo/[...path]/route.ts": `export const { GET, POST } = createVendoHandler();`,
      "src/app/vendo-root.tsx": `export function AppVendoRoot() { return null }`,
    });
    const state = await inspectVendoState(dir);
    expect(state.wired).toEqual({ appDir: "src/app", routeFile: true, rootFile: true, wired: true });
  });

  it("reports an unwired app (App Router root present, but no route/root files yet)", async () => {
    const dir = app({ "app/layout.tsx": NEXT_LAYOUT });
    const state = await inspectVendoState(dir);
    expect(state.wired).toEqual({ appDir: "app", routeFile: false, rootFile: false, wired: false });
  });

  it("does not scan inside .vendo/ for remix anchors", async () => {
    const dir = app({
      ".vendo/components/Badge/impl.tsx": `<VendoRemix id="should-not-count" />`,
    });
    const state = await inspectVendoState(dir);
    expect(state.remixAnchors).toEqual([]);
  });
});
