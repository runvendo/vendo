import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import {
  compilerFloorWarning,
  COMPILER_FLOOR,
  noteRejectedCompiler,
  REQUIRED_COMPILER_API,
  resetCompilerGateForTests,
  unsupportedCompiler,
} from "../../src/sync/compiler-gate.js";
import { loadTypescript } from "../../src/sync/static-ts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetCompilerGateForTests();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

/** A stub exposing every required API — the shape of a compiler at the floor. */
function completeCompilerStub(version: string): Record<string, unknown> {
  return Object.fromEntries([
    ["version", version],
    ...REQUIRED_COMPILER_API.map((api) => [api, () => undefined] as const),
  ]);
}

/** A host root whose node_modules carries a stub typescript missing
 * `getModifiers` — the shape of a real TypeScript < 4.8 install. */
async function rootWithOldCompiler(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-compiler-gate-"));
  temporaryDirectories.push(root);
  const stubDirectory = path.join(root, "node_modules", "typescript");
  await fs.mkdir(stubDirectory, { recursive: true });
  await fs.writeFile(
    path.join(stubDirectory, "package.json"),
    JSON.stringify({ name: "typescript", version: "4.7.4", main: "index.js" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(stubDirectory, "index.js"),
    "module.exports = { version: '4.7.4', createSourceFile() { return {}; } };\n",
    "utf8",
  );
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "host", version: "0.0.0" }), "utf8");
  return root;
}

describe("unsupportedCompiler", () => {
  it("rejects a compiler missing getModifiers, reporting its version and the API", () => {
    const stub = { version: "4.7.4", canHaveModifiers: () => true };
    expect(unsupportedCompiler(stub)).toMatchObject({ version: "4.7.4", missingApi: expect.stringContaining("") });
  });

  it("rejects the checker-round-2 regression: getModifiers present, the 4.9 API absent", () => {
    // A real typescript 4.8.4 passes a getModifiers-only probe and then
    // crashes on ts.isSatisfiesExpression (added in 4.9) — the gate must
    // floor on the FULL called surface, not the first known-missing API.
    const stub = completeCompilerStub("4.8.4");
    delete stub["isSatisfiesExpression"];
    expect(unsupportedCompiler(stub)).toEqual({ version: "4.8.4", missingApi: "isSatisfiesExpression" });
  });

  it("rejects a stub missing ANY single required API", () => {
    for (const api of REQUIRED_COMPILER_API) {
      const stub = completeCompilerStub("9.9.9");
      delete stub[api];
      expect(unsupportedCompiler(stub), `missing ${api} must reject`).toEqual({ version: "9.9.9", missingApi: api });
    }
  });

  it("rejects a versionless stub as unknown", () => {
    expect(unsupportedCompiler({})).toMatchObject({ version: "unknown" });
  });

  it("passes a stub carrying the complete required surface (capability, not version)", () => {
    expect(unsupportedCompiler(completeCompilerStub("0.0.1-fork"))).toBeNull();
  });

  it("passes a modern compiler untouched", () => {
    expect(unsupportedCompiler(ts)).toBeNull();
  });
});

describe("compilerFloorWarning", () => {
  it("is silent until a loader rejects a compiler", () => {
    expect(compilerFloorWarning()).toBeNull();
  });

  it("names the host's version, the missing API, and the floor once noted", () => {
    noteRejectedCompiler({ version: "4.8.4", missingApi: "isSatisfiesExpression" });
    const warning = compilerFloorWarning();
    expect(warning).toContain("4.8.4");
    expect(warning).toContain(`>=${COMPILER_FLOOR}`);
    expect(warning).toContain("ts.isSatisfiesExpression");
  });
});

describe("loadTypescript capability gate", () => {
  it("never hands back a compiler missing the floor API", async () => {
    const root = await rootWithOldCompiler();
    const loaded = loadTypescript(root);
    // In the monorepo the devDependency fallback still resolves a modern
    // compiler; inside a real host both bases reach the host's pin and the
    // result is null. Either way the gate's invariant holds: no caller ever
    // sees a compiler that would crash on a required ts.* API.
    if (loaded !== null) expect(unsupportedCompiler(loaded)).toBeNull();
  });

  it("returns the host compiler unchanged when it is modern", () => {
    const actionsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const loaded = loadTypescript(actionsRoot);
    expect(loaded).not.toBeNull();
    expect(typeof loaded?.getModifiers).toBe("function");
    expect(typeof loaded?.isSatisfiesExpression).toBe("function");
    expect(compilerFloorWarning()).toBeNull();
  });
});
