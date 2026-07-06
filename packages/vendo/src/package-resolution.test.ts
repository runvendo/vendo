import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = process.cwd();
const repoRoot = path.resolve(packageRoot, "../..");
const tempRoots: string[] = [];

interface SubpathCase {
  packageDir: string;
  packageName: string;
  subpath: string;
  expectedDts: string;
}

const node10SubpathCases: SubpathCase[] = [
  { packageDir: "vendo", packageName: "vendoai", subpath: "server", expectedDts: "dist/server.d.ts" },
  { packageDir: "vendo", packageName: "vendoai", subpath: "react", expectedDts: "dist/react.d.ts" },
  { packageDir: "vendo-components", packageName: "@vendoai/components", subpath: "descriptors", expectedDts: "dist/descriptors.d.ts" },
  { packageDir: "vendo-components", packageName: "@vendoai/components", subpath: "theme", expectedDts: "dist/theme/brand.d.ts" },
  { packageDir: "vendo-components", packageName: "@vendoai/components", subpath: "sandbox", expectedDts: "dist/sandbox-install.d.ts" },
  { packageDir: "vendo-core", packageName: "@vendoai/core", subpath: "testing", expectedDts: "dist/stub-agent.d.ts" },
  { packageDir: "vendo-server", packageName: "@vendoai/server", subpath: "capabilities", expectedDts: "dist/capabilities.d.ts" },
  { packageDir: "vendo-server", packageName: "@vendoai/server", subpath: "model", expectedDts: "dist/model.d.ts" },
  { packageDir: "vendo-server", packageName: "@vendoai/server", subpath: "manifest-tools", expectedDts: "dist/manifest-tools.d.ts" },
  { packageDir: "vendo-server", packageName: "@vendoai/server", subpath: "catalog", expectedDts: "dist/catalog.d.ts" },
  { packageDir: "vendo-stage", packageName: "@vendoai/stage", subpath: "build", expectedDts: "dist/build/preset.d.ts" },
];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-node10-resolution-"));
  tempRoots.push(root);
  return root;
}

function packageInstallDir(root: string, packageName: string): string {
  const parts = packageName.split("/");
  return path.join(root, "node_modules", ...parts);
}

async function installFixturePackage(root: string, testCase: SubpathCase): Promise<void> {
  const sourcePkg = path.join(repoRoot, "packages", testCase.packageDir, "package.json");
  const pkg = JSON.parse(await readFile(sourcePkg, "utf8")) as Record<string, unknown>;
  const installDir = packageInstallDir(root, testCase.packageName);
  await mkdir(path.join(installDir, path.dirname(testCase.expectedDts)), { recursive: true });
  await writeFile(path.join(installDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  await writeFile(path.join(installDir, "dist/index.d.ts"), "export {};\n");
  await writeFile(path.join(installDir, "dist/index.js"), "export {};\n");
  await writeFile(path.join(installDir, testCase.expectedDts), "export {};\n");
  await writeFile(path.join(installDir, testCase.expectedDts.replace(/\.d\.ts$/, ".js")), "export {};\n");
}

function resolveWithNode10(root: string, specifier: string): string | undefined {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
  const containingFile = path.join(root, "src", "index.ts");
  const host = ts.createCompilerHost(options, true);
  host.getCurrentDirectory = () => root;
  const resolved = ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule;
  return resolved?.resolvedFileName;
}

describe("package metadata compatibility", () => {
  it("exposes public subpath types to TypeScript's Node10 resolver", async () => {
    const root = await makeTempRoot();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-app" }, null, 2) + "\n");
    await writeFile(path.join(root, "src", "index.ts"), "");

    for (const testCase of node10SubpathCases) {
      await installFixturePackage(root, testCase);
      const specifier = `${testCase.packageName}/${testCase.subpath}`;
      const resolved = resolveWithNode10(root, specifier);
      expect(resolved, specifier).toBeDefined();
      expect(path.relative(
        await realpath(packageInstallDir(root, testCase.packageName)),
        await realpath(resolved!),
      )).toBe(testCase.expectedDts);
    }
  });
});
