import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installLocalVendoPackages, rewritePackageJsonForLocalVendo, type LocalTarball } from "./local-pack.js";

const TEST_PACKAGE_VERSION = "0.1.0";
const vendoTarball = (name: string) => `${name.replace("@", "").replace("/", "-")}-${TEST_PACKAGE_VERSION}.tgz`;
const vendoPkgTarball = vendoTarball("vendo");
const shellTarball = vendoTarball("@vendoai/shell");
const coreTarball = vendoTarball("@vendoai/core");

const LOCAL_TARBALLS: LocalTarball[] = [
  { name: "vendo", fileName: vendoPkgTarball },
  { name: "@vendoai/components", fileName: vendoTarball("@vendoai/components") },
  { name: "@vendoai/core", fileName: coreTarball },
  { name: "@vendoai/react", fileName: vendoTarball("@vendoai/react") },
  { name: "@vendoai/runtime", fileName: vendoTarball("@vendoai/runtime") },
  { name: "@vendoai/server", fileName: vendoTarball("@vendoai/server") },
  { name: "@vendoai/shell", fileName: shellTarball },
  { name: "@vendoai/stage", fileName: vendoTarball("@vendoai/stage") },
  { name: "@vendoai/store", fileName: vendoTarball("@vendoai/store") },
  { name: "@vendoai/telemetry", fileName: vendoTarball("@vendoai/telemetry") },
  { name: "fluidkit", fileName: "fluidkit-0.5.0-656857b.tgz" },
];

describe("rewritePackageJsonForLocalVendo", () => {
  it("writes direct file dependencies and pnpm overrides for every local tarball", () => {
    const out = rewritePackageJsonForLocalVendo(
      JSON.stringify({
        name: "host",
        packageManager: "pnpm@9.12.0",
        dependencies: { next: "16.0.0", vendo: "latest" },
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
    expect(pkg.dependencies["vendo"]).toBe(`file:vendor/${vendoPkgTarball}`);
    // only `vendo` is a direct dependency now — every @vendoai/* internal is
    // pinned to the local tarball via pnpm.overrides instead.
    expect(pkg.dependencies["@vendoai/shell"]).toBeUndefined();
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
    expect(pkg.dependencies["vendo"]).toBe(`file:vendor/${vendoPkgTarball}`);
    expect(pkg.overrides["@vendoai/shell"]).toBe(`file:vendor/${shellTarball}`);
    expect(pkg.overrides["@vendoai/core"]).toBe(`file:vendor/${coreTarball}`);
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
    expect(unsupported.manual).toContain(`"vendo": "file:vendor/${vendoPkgTarball}"`);
  });
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

async function createPackableLocalRepo(withFluidkit = true): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "vendo local repo "));
  expect(repoDir).toContain(" ");
  // `vendo` is the closure root (LOCAL_DIRECT_DEPENDENCIES); its own
  // dependency on `@vendoai/shell` is what pulls that package into the walk
  // (discoverLocalPackageClosure only inspects the dependency key, not the
  // specifier, so a plain semver range avoids requiring a real `pnpm install`
  // for `workspace:*` resolution in this ad hoc fixture repo).
  const vendoDir = path.join(repoDir, "packages", "vendo");
  await writeJson(path.join(vendoDir, "package.json"), {
    name: "vendo",
    version: TEST_PACKAGE_VERSION,
    type: "module",
    main: "index.js",
    files: ["index.js"],
    dependencies: { "@vendoai/shell": TEST_PACKAGE_VERSION },
  });
  await writeFile(path.join(vendoDir, "index.js"), "export {};\n");

  const shellDir = path.join(repoDir, "packages", "vendo-shell");
  await writeJson(path.join(shellDir, "package.json"), {
    name: "@vendoai/shell",
    version: TEST_PACKAGE_VERSION,
    type: "module",
    main: "index.js",
    files: ["index.js"],
  });
  await writeFile(path.join(shellDir, "index.js"), "export {};\n");

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
    expect(vendorFiles).toContain(vendoPkgTarball);
    expect(vendorFiles).toContain(shellTarball);
    expect(vendorFiles).toContain("fluidkit-0.5.0-test.tgz");

    const pkg = JSON.parse(await readFile(path.join(targetDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    expect(pkg.dependencies["vendo"]).toBe(`file:vendor/${vendoPkgTarball}`);
    expect(pkg.dependencies["@vendoai/shell"]).toBeUndefined();
    expect(pkg.pnpm.overrides["vendo"]).toBe(`file:vendor/${vendoPkgTarball}`);
    expect(pkg.pnpm.overrides["@vendoai/shell"]).toBe(`file:vendor/${shellTarball}`);
    expect(pkg.pnpm.overrides["fluidkit"]).toBe("file:vendor/fluidkit-0.5.0-test.tgz");
  });

  it("preflights fluidkit before creating target vendor artifacts", async () => {
    const repoDir = await createPackableLocalRepo(false);
    const targetDir = await createTargetApp();
    await expect(installLocalVendoPackages(targetDir, repoDir)).rejects.toThrow("fluidkit");
    await expect(readdir(path.join(targetDir, "vendor"))).rejects.toThrow();
  });
});
