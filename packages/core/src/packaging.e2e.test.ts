/**
 * Packaging e2e — consumes @vendoai/core exactly the way the other blocks
 * will: `pnpm pack` the real artifact, extract it, resolve the exports map,
 * and import the PACKED dist (not src). Core is the zero-I/O block, so this
 * is its whole e2e surface: no live seams, no keys. The Bun leg runs when a
 * bun binary is present (local dev) and is skipped cleanly where it isn't.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORK_DIR = join(PACKAGE_DIR, ".e2e-pack");

const RUNTIME_EXPORTS = [
  "VENDO_APP_FORMAT", "VENDO_TREE_FORMAT", "VENDO_TOOLS_FORMAT", "VENDO_OVERRIDES_FORMAT",
  "VENDO_POLICY_FORMAT", "descriptorHash", "validateTree", "validateAppDocument", "VendoError",
  "safeErrorMessage", "canonicalJson", "sha256Hex", "TOOL_NAME_PATTERN",
  "TREE_MAX_NODES", "TREE_MAX_QUERIES", "TREE_MAX_GENERATED_COMPONENTS",
  "TREE_MAX_COMPONENT_SOURCE_CHARS", "TREE_MAX_TOTAL_COMPONENT_CHARS", "RESERVED_COMPONENT_NAMES",
  "isPathBinding", "isStateBinding",
  "principalSchema", "runContextSchema", "triggerRefSchema", "riskLabelSchema",
  "toolDescriptorSchema", "toolCallSchema", "toolOutcomeSchema", "grantConstraintSchema",
  "grantScopeSchema", "grantDurationSchema", "permissionGrantSchema", "approvalRequestSchema",
  "approvalDecisionSchema", "guardDecisionSchema", "auditEventSchema", "uiPayloadSchema",
  "treeSchema", "treeNodeSchema", "treeQuerySchema", "appDocumentSchema", "storageDeclSchema",
  "pinSchema", "triggerSourceSchema", "runModelSchema", "stepSchema", "triggerSchema",
  "vendoRecordSchema", "recordQuerySchema", "authMaterialSchema", "agentRunReportSchema",
  "vendoThemeSchema", "vendoViewPartSchema", "vendoApprovalPartSchema", "vendoErrorCodeSchema",
  "appIdSchema", "grantIdSchema", "approvalIdSchema", "runIdSchema", "threadIdSchema",
  "isoDateTimeSchema", "jsonSchemaSchema",
];

interface PackedPackage {
  dir: string;
  manifest: Record<string, unknown>;
  resolve(subpath: "." | "./conformance"): string;
}

let packedCache: PackedPackage | undefined;

const packOnce = (): PackedPackage => {
  if (packedCache !== undefined) return packedCache;
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  execFileSync("pnpm", ["pack", "--pack-destination", WORK_DIR], { cwd: PACKAGE_DIR, stdio: "pipe" });
  const tarball = readdirSync(WORK_DIR).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("pnpm pack produced no tarball");
  execFileSync("tar", ["-xzf", join(WORK_DIR, tarball), "-C", WORK_DIR], { stdio: "pipe" });
  const dir = join(WORK_DIR, "package");
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const exportsMap = manifest.exports as Record<string, { types: string; default: string }>;
  packedCache = {
    dir,
    manifest,
    resolve: (subpath) => join(dir, exportsMap[subpath].default),
  };
  return packedCache;
};

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

describe("packaging e2e — the artifact blocks will install", () => {
  it("packs with a well-formed manifest: dist only, both subpaths, types beside code", () => {
    const packed = packOnce();
    const exportsMap = packed.manifest.exports as Record<string, { types: string; default: string }>;
    for (const subpath of [".", "./conformance"] as const) {
      expect(exportsMap[subpath]).toBeDefined();
      expect(existsSync(packed.resolve(subpath))).toBe(true);
      expect(existsSync(join(packed.dir, exportsMap[subpath].types))).toBe(true);
    }
    // dist-only artifact: no sources, no tests, no vectors in the tarball
    expect(existsSync(join(packed.dir, "src"))).toBe(false);
    expect(existsSync(join(packed.dir, "vectors"))).toBe(false);
  });

  it("root import exposes the full contract surface and behaves", async () => {
    const packed = packOnce();
    const core = await import(pathToFileURL(packed.resolve(".")).href);
    const missing = RUNTIME_EXPORTS.filter((name) => !(name in core));
    expect(missing).toEqual([]);

    // behavior spot-checks through the packed artifact
    const tree = core.validateTree({
      formatVersion: "vendo-genui/v1",
      root: "a",
      nodes: [{ id: "a", component: "Text" }],
    });
    expect(tree.ok).toBe(true);
    const err = new core.VendoError("not-found", "missing");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("not-found");
  });

  it("reproduces the committed descriptor-hash vectors from the packed artifact", async () => {
    const packed = packOnce();
    const core = await import(pathToFileURL(packed.resolve(".")).href);
    const vectors = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "vectors", "descriptor-hash.json"), "utf8"),
    ) as { vectors: Array<{ name: string; descriptor: unknown; canonical: string; hash: string }> };
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(5);
    for (const vector of vectors.vectors) {
      expect(core.canonicalJson({
        name: (vector.descriptor as { name: string }).name,
        description: (vector.descriptor as { description: string }).description,
        inputSchema: (vector.descriptor as { inputSchema: unknown }).inputSchema,
        risk: (vector.descriptor as { risk: string }).risk,
        ...((vector.descriptor as { critical?: boolean }).critical !== undefined
          ? { critical: (vector.descriptor as { critical?: boolean }).critical }
          : {}),
      })).toBe(vector.canonical);
      expect(core.descriptorHash(vector.descriptor)).toBe(vector.hash);
    }
  });

  it("conformance subpath is consumable: memory double passes its own suite", async () => {
    const packed = packOnce();
    const conformance = await import(pathToFileURL(packed.resolve("./conformance")).href);
    const report = await conformance.runConformance(conformance.storeAdapterConformance({
      async makeAdapter() {
        return { adapter: conformance.memoryStoreAdapter() };
      },
    }));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("ships a platform-clean dist (no node:/platform imports — edge/Bun-portable)", () => {
    const packed = packOnce();
    const distDir = join(packed.dir, "dist");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
    for (const file of walk(distDir).filter((name) => name.endsWith(".js"))) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} imports a platform module`).not.toMatch(/from\s+["']node:/);
      expect(source, `${file} uses require`).not.toMatch(/\brequire\s*\(/);
    }
  });

  it("imports and runs on Bun when a bun binary is available (skips cleanly otherwise)", () => {
    const packed = packOnce();
    let bunPath: string;
    try {
      bunPath = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    } catch {
      console.log("bun not installed — Bun leg skipped (runs on machines with bun)");
      return;
    }
    const script = `
      const core = await import(${JSON.stringify(pathToFileURL(packed.resolve(".")).href)});
      const conf = await import(${JSON.stringify(pathToFileURL(packed.resolve("./conformance")).href)});
      const tree = core.validateTree({ formatVersion: "vendo-genui/v1", root: "a", nodes: [{ id: "a", component: "Text" }] });
      const hash = core.descriptorHash({ name: "t", description: "", inputSchema: {}, risk: "read" });
      const report = await conf.runConformance(conf.storeAdapterConformance({ makeAdapter: async () => ({ adapter: conf.memoryStoreAdapter() }) }));
      if (!tree.ok || !hash.startsWith("sha256:") || !report.ok) throw new Error("bun leg failed");
      console.log("BUN_OK");
    `;
    const output = execFileSync(bunPath, ["-e", script], { encoding: "utf8" });
    expect(output).toContain("BUN_OK");
  });
});
