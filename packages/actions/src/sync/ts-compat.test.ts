import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import realTs from "typescript";
import { extractServerActions } from "./server-actions.js";
import type { Ts } from "./static-ts.js";
import { isSatisfiesExpressionNode, modifiersOf } from "./ts-compat.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryHost(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-tscompat-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeFile(root: string, relative: string, source: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

/** The workspace compiler with the TS 4.8/4.9 APIs removed, approximating a
 * pre-4.8 host TypeScript at the API-surface level. */
function legacyTs(): Ts {
  return {
    ...realTs,
    canHaveModifiers: undefined,
    getModifiers: undefined,
    isSatisfiesExpression: undefined,
  } as unknown as Ts;
}

function firstStatement(source: string): realTs.Statement {
  const sf = realTs.createSourceFile("probe.ts", source, realTs.ScriptTarget.Latest, true);
  return sf.statements[0]!;
}

describe("modifiersOf", () => {
  it("reads modifiers through the modern API when available", () => {
    const statement = firstStatement("export default async function run() {}");
    const kinds = modifiersOf(realTs, statement).map((modifier) => modifier.kind);
    expect(kinds).toContain(realTs.SyntaxKind.ExportKeyword);
    expect(kinds).toContain(realTs.SyntaxKind.DefaultKeyword);
  });

  it("falls back to the legacy modifiers property when the API is missing", () => {
    const statement = firstStatement("export default async function run() {}");
    const kinds = modifiersOf(legacyTs(), statement).map((modifier) => modifier.kind);
    expect(kinds).toContain(realTs.SyntaxKind.ExportKeyword);
    expect(kinds).toContain(realTs.SyntaxKind.DefaultKeyword);
  });

  it("returns an empty list for nodes without modifiers on both paths", () => {
    const statement = firstStatement("const value = 1;");
    expect(modifiersOf(realTs, statement)).toEqual([]);
    expect(modifiersOf(legacyTs(), statement)).toEqual([]);
  });

  it("reads modifiers from a real TypeScript 4.7 compiler through the legacy path", () => {
    const oldTs = createRequire(import.meta.url)("typescript47") as unknown as Ts;
    const sf = oldTs.createSourceFile("probe.ts", "export default async function run() {}", oldTs.ScriptTarget.Latest, true);
    const kinds = modifiersOf(oldTs, sf.statements[0]!).map((modifier) => modifier.kind);
    expect(kinds).toContain(oldTs.SyntaxKind.ExportKeyword);
    expect(kinds).toContain(oldTs.SyntaxKind.DefaultKeyword);
  });
});

describe("isSatisfiesExpressionNode", () => {
  it("detects satisfies expressions through the modern API", () => {
    const statement = firstStatement("const value = {} satisfies object;");
    const declaration = (statement as realTs.VariableStatement).declarationList.declarations[0]!;
    expect(isSatisfiesExpressionNode(realTs, declaration.initializer!)).toBe(true);
  });

  it("reports false for other nodes and for compilers without the API", () => {
    const statement = firstStatement("const value = {} satisfies object;");
    const declaration = (statement as realTs.VariableStatement).declarationList.declarations[0]!;
    expect(isSatisfiesExpressionNode(realTs, declaration)).toBe(false);
    expect(isSatisfiesExpressionNode(legacyTs(), declaration.initializer!)).toBe(false);
  });
});

describe("extraction against a real TypeScript 4.7 host", () => {
  it("extracts server actions with the genuine 4.7 compiler, which lacks the 4.8/4.9 APIs", async () => {
    const root = await temporaryHost();
    const oldTs = createRequire(import.meta.url).resolve("typescript47");
    const loaded = createRequire(import.meta.url)("typescript47") as { version: string; getModifiers?: unknown };
    expect(loaded.version).toBe("4.7.4");
    expect(loaded.getModifiers).toBeUndefined();

    await writeFile(root, "package.json", JSON.stringify({
      name: "old-ts-host",
      dependencies: { next: "16.0.0", typescript: "4.7.4" },
    }));
    await writeFile(root, "node_modules/typescript/package.json", JSON.stringify({
      name: "typescript",
      version: "4.7.4",
      main: "index.js",
    }));
    await writeFile(root, "node_modules/typescript/index.js", `module.exports = require(${JSON.stringify(oldTs)});\n`);
    await writeFile(root, "src/actions/tokens.ts", `
"use server";

export async function createToken(name: string) {
  return { name };
}
`);

    const result = await extractServerActions(root);
    const names = result.tools.map((tool) => tool.name);
    expect(names.some((name) => name.includes("create_token"))).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
