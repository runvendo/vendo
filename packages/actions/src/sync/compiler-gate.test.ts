import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import {
  compilerFloorWarning,
  noteRejectedCompiler,
  resetCompilerGateForTests,
  unsupportedCompilerVersion,
} from "./compiler-gate.js";
import { loadTypescript } from "./static-ts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetCompilerGateForTests();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

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

describe("unsupportedCompilerVersion", () => {
  it("rejects a compiler missing getModifiers, reporting its version", () => {
    const stub = { version: "4.7.4", canHaveModifiers: () => true };
    expect(unsupportedCompilerVersion(stub)).toBe("4.7.4");
  });

  it("rejects a versionless stub as unknown", () => {
    expect(unsupportedCompilerVersion({})).toBe("unknown");
  });

  it("passes a modern compiler untouched", () => {
    expect(unsupportedCompilerVersion(ts)).toBeNull();
  });
});

describe("compilerFloorWarning", () => {
  it("is silent until a loader rejects a compiler", () => {
    expect(compilerFloorWarning()).toBeNull();
  });

  it("names the host's version and the 4.8 floor once noted", () => {
    noteRejectedCompiler("4.7.4");
    const warning = compilerFloorWarning();
    expect(warning).toContain("4.7.4");
    expect(warning).toContain("4.8");
    expect(warning).toContain("getModifiers");
  });
});

describe("loadTypescript capability gate", () => {
  it("never hands back a compiler missing the floor API", async () => {
    const root = await rootWithOldCompiler();
    const loaded = loadTypescript(root);
    // In the monorepo the devDependency fallback still resolves a modern
    // compiler; inside a real host both bases reach the host's pin and the
    // result is null. Either way the gate's invariant holds: no caller ever
    // sees a compiler that would crash on ts.getModifiers.
    if (loaded !== null) expect(unsupportedCompilerVersion(loaded)).toBeNull();
  });

  it("returns the host compiler unchanged when it is modern", () => {
    const actionsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const loaded = loadTypescript(actionsRoot);
    expect(loaded).not.toBeNull();
    expect(typeof loaded?.getModifiers).toBe("function");
    expect(compilerFloorWarning()).toBeNull();
  });
});
