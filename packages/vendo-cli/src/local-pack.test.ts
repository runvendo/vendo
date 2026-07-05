import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installLocalVendoPackages, rewritePackageJsonForLocalVendo, type LocalTarball } from "./local-pack.js";

const LOCAL_TARBALLS: LocalTarball[] = [
  { name: "@vendoai/components", fileName: "vendoai-components-0.0.0.tgz" },
  { name: "@vendoai/core", fileName: "vendoai-core-0.0.0.tgz" },
  { name: "@vendoai/next", fileName: "vendoai-next-0.0.0.tgz" },
  { name: "@vendoai/react", fileName: "vendoai-react-0.0.0.tgz" },
  { name: "@vendoai/runtime", fileName: "vendoai-runtime-0.0.0.tgz" },
  { name: "@vendoai/server", fileName: "vendoai-server-0.0.0.tgz" },
  { name: "@vendoai/shell", fileName: "vendoai-shell-0.0.0.tgz" },
  { name: "@vendoai/stage", fileName: "vendoai-stage-0.0.0.tgz" },
  { name: "@vendoai/store", fileName: "vendoai-store-0.0.0.tgz" },
  { name: "@vendoai/telemetry", fileName: "vendoai-telemetry-0.0.0.tgz" },
  { name: "fluidkit", fileName: "fluidkit-0.5.0-656857b.tgz" },
];

describe("rewritePackageJsonForLocalVendo", () => {
  it("writes direct file dependencies and pnpm overrides for every local tarball", () => {
    const out = rewritePackageJsonForLocalVendo(
      JSON.stringify({
        name: "host",
        packageManager: "pnpm@9.12.0",
        dependencies: { next: "16.0.0", "@vendoai/next": "latest" },
        pnpm: { overrides: { "@types/react": "^19.2.0" } },
      }),
      LOCAL_TARBALLS,
      { packageManager: "pnpm" },
    );
    expect(out.kind).toBe("updated");
    if (out.kind !== "updated") throw new Error("expected local package rewrite");
    const pkg = JSON.parse(out.source) as {
      dependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    expect(pkg.dependencies["@vendoai/next"]).toBe("file:vendor/vendoai-next-0.0.0.tgz");
    expect(pkg.dependencies["@vendoai/shell"]).toBe("file:vendor/vendoai-shell-0.0.0.tgz");
    expect(pkg.dependencies["next"]).toBe("16.0.0");
    for (const tarball of LOCAL_TARBALLS) {
      expect(pkg.pnpm.overrides[tarball.name]).toBe(`file:vendor/${tarball.fileName}`);
    }
    expect(pkg.pnpm.overrides["@types/react"]).toBe("^19.2.0");
  });

  it("uses npm overrides as the fallback package-manager shape", () => {
    const out = rewritePackageJsonForLocalVendo(
      JSON.stringify({
        name: "host",
        dependencies: { react: "^19.0.0" },
        overrides: { eslint: { chalk: "5.0.0" }, zod: "^3.24.0" },
      }),
      LOCAL_TARBALLS,
      { packageManager: "npm" },
    );
    expect(out.kind).toBe("updated");
    if (out.kind !== "updated") throw new Error("expected local package rewrite");
    const pkg = JSON.parse(out.source) as {
      dependencies: Record<string, string>;
      overrides: Record<string, unknown>;
      pnpm?: unknown;
    };
    expect(pkg.dependencies["@vendoai/next"]).toBe("file:vendor/vendoai-next-0.0.0.tgz");
    expect(pkg.dependencies["@vendoai/shell"]).toBe("file:vendor/vendoai-shell-0.0.0.tgz");
    expect(pkg.overrides["@vendoai/core"]).toBe("file:vendor/vendoai-core-0.0.0.tgz");
    expect(pkg.overrides["fluidkit"]).toBe("file:vendor/fluidkit-0.5.0-656857b.tgz");
    expect(pkg.overrides["zod"]).toBe("^3.24.0");
    expect(pkg.overrides["eslint"]).toEqual({ chalk: "5.0.0" });
    expect(pkg.pnpm).toBeUndefined();
  });

  it("skips with manual instructions for invalid or unsupported package.json shapes", () => {
    const invalid = rewritePackageJsonForLocalVendo("{nope", LOCAL_TARBALLS, { packageManager: "pnpm" });
    expect(invalid.kind).toBe("skipped");
    if (invalid.kind !== "skipped") throw new Error("expected local package rewrite skip");
    expect(invalid.manual).toContain("pnpm.overrides");

    const incomplete = rewritePackageJsonForLocalVendo("{}", LOCAL_TARBALLS.filter((tarball) => tarball.name !== "fluidkit"), {
        packageManager: "pnpm",
      });
    expect(incomplete.kind).toBe("skipped");

    const unsupported = rewritePackageJsonForLocalVendo(JSON.stringify({ overrides: "eslint@8" }), LOCAL_TARBALLS, {
      packageManager: "npm",
    });
    expect(unsupported.kind).toBe("skipped");
    if (unsupported.kind !== "skipped") throw new Error("expected local package rewrite skip");
    expect(unsupported.reason).toContain("overrides is not an object");
    expect(unsupported.manual).toContain("@vendoai/next");
  });
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

async function createPackableLocalRepo(withFluidkit = true): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "vendo local repo "));
  expect(repoDir).toContain(" ");
  for (const [dirName, name] of [
    ["vendo-next", "@vendoai/next"],
    ["vendo-shell", "@vendoai/shell"],
  ] as const) {
    const pkgDir = path.join(repoDir, "packages", dirName);
    await writeJson(path.join(pkgDir, "package.json"), {
      name,
      version: "0.0.0",
      type: "module",
      main: "index.js",
      files: ["index.js"],
    });
    await writeFile(path.join(pkgDir, "index.js"), "export {};\n");
  }
  if (withFluidkit) {
    await mkdir(path.join(repoDir, "vendor"), { recursive: true });
    await writeFile(path.join(repoDir, "vendor/fluidkit-0.5.0-test.tgz"), "not a real tarball");
  }
  return repoDir;
}

async function createTargetApp(): Promise<string> {
  const targetDir = await mkdtemp(path.join(tmpdir(), "vendo-local-target-"));
  await writeJson(path.join(targetDir, "package.json"), {
    name: "host",
    packageManager: "pnpm@9.12.0",
    dependencies: { next: "16.0.0" },
  });
  return targetDir;
}

describe("installLocalVendoPackages", () => {
  it("packs with real pnpm from a local repo path containing spaces", async () => {
    const repoDir = await createPackableLocalRepo();
    const targetDir = await createTargetApp();
    const summary = await installLocalVendoPackages(targetDir, repoDir);
    expect(summary.installCommand).toBe("pnpm install");

    const vendorFiles = await readdir(path.join(targetDir, "vendor"));
    expect(vendorFiles).toContain("vendoai-next-0.0.0.tgz");
    expect(vendorFiles).toContain("vendoai-shell-0.0.0.tgz");
    expect(vendorFiles).toContain("fluidkit-0.5.0-test.tgz");

    const pkg = JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    expect(pkg.dependencies["@vendoai/next"]).toBe("file:vendor/vendoai-next-0.0.0.tgz");
    expect(pkg.dependencies["@vendoai/shell"]).toBe("file:vendor/vendoai-shell-0.0.0.tgz");
    expect(pkg.pnpm.overrides["@vendoai/next"]).toBe("file:vendor/vendoai-next-0.0.0.tgz");
    expect(pkg.pnpm.overrides["@vendoai/shell"]).toBe("file:vendor/vendoai-shell-0.0.0.tgz");
    expect(pkg.pnpm.overrides["fluidkit"]).toBe("file:vendor/fluidkit-0.5.0-test.tgz");
  });

  it("preflights fluidkit before creating target vendor artifacts", async () => {
    const repoDir = await createPackableLocalRepo(false);
    const targetDir = await createTargetApp();
    await expect(installLocalVendoPackages(targetDir, repoDir)).rejects.toThrow("fluidkit");
    await expect(readdir(path.join(targetDir, "vendor"))).rejects.toThrow();
  });
});
