import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMarkedDiff,
  deriveStarter,
  isWhollyVendoOwned,
  starterPackageJson,
  stripVendoBlocks,
} from "./marked-diff.js";

const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const EXAMPLES = ["ai-sdk-agent", "mastra-agent"] as const;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("stripVendoBlocks", () => {
  it("removes fenced lines inclusive of both markers", () => {
    const source = "a\n// --- vendo: added\nb\n// --- /vendo\nc";
    expect(stripVendoBlocks(source)).toBe("a\nc");
  });

  it("handles multiple blocks and JSX comment markers", () => {
    const source = "keep\n{/* --- vendo */}\n<VendoProvider>\n{/* --- /vendo */}\nmiddle\n// --- vendo\n</VendoProvider>\n// --- /vendo\nend";
    expect(stripVendoBlocks(source)).toBe("keep\nmiddle\nend");
  });

  it("throws on an unclosed block", () => {
    expect(() => stripVendoBlocks("x\n// --- vendo\ny")).toThrow(/unclosed/);
  });

  it("throws on a stray closing marker", () => {
    expect(() => stripVendoBlocks("x\n// --- /vendo\ny")).toThrow(/without an opening/);
  });

  it("detects wholly vendo-owned files", () => {
    expect(isWhollyVendoOwned("// --- vendo\nimport x from 'y';\n// --- /vendo\n")).toBe(true);
    expect(isWhollyVendoOwned("import x from 'y';\n// --- vendo\nz\n// --- /vendo\n")).toBe(false);
  });
});

describe("starterPackageJson", () => {
  it("drops every Vendo package and the example test rig", () => {
    const stripped = JSON.parse(starterPackageJson(JSON.stringify({
      name: "@vendoai-examples/ai-sdk-agent",
      scripts: { dev: "next dev", test: "vitest run" },
      dependencies: { "@vendoai/vendo": "workspace:*", ai: "6.0.28", vendoai: "workspace:*" },
      devDependencies: { "@vendoai/core": "workspace:*", vitest: "^3", typescript: "^5" },
    }))) as { name: string; scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(stripped.name).toBe("journey-starter-ai-sdk-agent");
    expect(stripped.scripts).toEqual({ dev: "next dev" });
    expect(stripped.dependencies).toEqual({ ai: "6.0.28" });
    expect(stripped.devDependencies).toEqual({ typescript: "^5" });
  });
});

// The contract the journeys ride: for each shipped example, the starter
// derivation produces a Vendo-free tree, and applying the marked diff back
// reproduces the example byte-for-byte. Markers alone carry the integration.
describe.each(EXAMPLES)("examples/%s marked diff", (example) => {
  const exampleDir = path.join(workspaceRoot, "examples", example);

  it("derives a starter and round-trips back to the example", async () => {
    const starter = await tempDir(`vendo-starter-${example}-`);
    const derivation = await deriveStarter(exampleDir, starter);
    expect(derivation.written).toContain("package.json");
    // The BYO surface is not in the starter…
    expect(derivation.vendoOwned).toContain(".vendo/tools.json");
    expect(derivation.vendoOwned.some((rel) => rel.endsWith("lib/vendo.ts"))).toBe(true);
    expect(derivation.vendoOwned.some((rel) => rel.includes("api/vendo/"))).toBe(true);
    const starterPackage = await readFile(path.join(starter, "package.json"), "utf8");
    expect(starterPackage).not.toContain("@vendoai");

    // …and the marked diff alone brings the example back exactly.
    const applied = await applyMarkedDiff(exampleDir, starter);
    expect(applied).toEqual(expect.arrayContaining(derivation.vendoOwned));
    // Runtime state never rides the diff: transplanting a live PGlite cluster
    // file-by-file leaves an unstartable database in the scaffold.
    expect(applied.every((rel) => !rel.startsWith(".vendo/data")), ".vendo/data leaked into the diff").toBe(true);
    for (const rel of applied) {
      const restored = await readFile(path.join(starter, rel), "utf8");
      const original = await readFile(path.join(exampleDir, rel), "utf8");
      expect(restored, rel).toBe(original);
    }
    // Every non-manifest file the diff touched carries its own markers.
    for (const rel of applied.filter((entry) => !entry.startsWith(".vendo/"))) {
      expect((await readFile(path.join(starter, rel), "utf8")).includes("--- vendo"), rel).toBe(true);
    }
  });

  it("keeps the starter bootable in shape: chat route and page survive stripping", async () => {
    const starter = await tempDir(`vendo-starter-shape-${example}-`);
    await deriveStarter(exampleDir, starter);
    const appDir = example === "ai-sdk-agent" ? "app" : "src/app";
    for (const rel of [`${appDir}/api/chat/route.ts`, `${appDir}/page.tsx`, "next.config.ts"]) {
      const content = await readFile(path.join(starter, rel), "utf8");
      expect(content).not.toContain("vendo");
      expect(content.trim().length).toBeGreaterThan(0);
    }
    await expect(stat(path.join(starter, appDir, "api/vendo"))).rejects.toThrow();
  });
});
