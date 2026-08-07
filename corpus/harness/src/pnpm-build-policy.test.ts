import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pnpmDeclaresBuiltDependencies } from "./pnpm-build-policy.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-pnpm-build-policy-"));
  tempRoots.push(root);
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

describe("pnpmDeclaresBuiltDependencies", () => {
  it("is true when pnpm-workspace.yaml declares onlyBuiltDependencies", async () => {
    const dir = await makeTempRoot();
    await writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - '.'\nonlyBuiltDependencies:\n  - prisma\n");

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(true);
  });

  it("is true when pnpm-workspace.yaml declares neverBuiltDependencies", async () => {
    const dir = await makeTempRoot();
    await writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - '.'\nneverBuiltDependencies:\n  - esbuild\n");

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(true);
  });

  it("is true when pnpm-workspace.yaml declares allowBuilds", async () => {
    const dir = await makeTempRoot();
    await writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - '.'\nallowBuilds:\n  '@prisma/engines': true\n");

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(true);
  });

  it("is true when package.json's pnpm field declares onlyBuiltDependencies under a pnpm ≤10 pin", async () => {
    const dir = await makeTempRoot();
    await writeJson(path.join(dir, "package.json"), {
      name: "fixture",
      packageManager: "pnpm@10.4.1",
      pnpm: { onlyBuiltDependencies: ["prisma"] },
    });

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(true);
  });

  it("is true when package.json's pnpm field declares neverBuiltDependencies under a pnpm ≤10 pin", async () => {
    const dir = await makeTempRoot();
    await writeJson(path.join(dir, "package.json"), {
      name: "fixture",
      packageManager: "pnpm@10.4.1",
      pnpm: { neverBuiltDependencies: ["esbuild"] },
    });

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(true);
  });

  it("is true when package.json's pnpm field declares allowBuilds under a pnpm ≤10 pin", async () => {
    const dir = await makeTempRoot();
    await writeJson(path.join(dir, "package.json"), {
      name: "fixture",
      packageManager: "pnpm@10.4.1",
      pnpm: { allowBuilds: { "@prisma/engines": true } },
    });

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(true);
  });

  it("is false for package.json pnpm-field curation under a pnpm ≥11 pin — pnpm 11 ignores the field", async () => {
    const dir = await makeTempRoot();
    await writeJson(path.join(dir, "package.json"), {
      name: "fixture",
      packageManager: "pnpm@11.10.0",
      pnpm: { onlyBuiltDependencies: ["prisma"] },
    });

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(false);
  });

  it("is false for package.json pnpm-field curation with no packageManager pin — the harness environment runs pnpm 11", async () => {
    const dir = await makeTempRoot();
    await writeJson(path.join(dir, "package.json"), {
      name: "fixture",
      pnpm: { onlyBuiltDependencies: ["prisma"] },
    });

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(false);
  });

  it("is true when pnpm-workspace.yaml curates builds regardless of the pnpm pin — every pnpm ≥10 reads the yaml", async () => {
    const dir = await makeTempRoot();
    await writeJson(path.join(dir, "package.json"), {
      name: "fixture",
      packageManager: "pnpm@11.10.0",
    });
    await writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - '.'\nonlyBuiltDependencies:\n  - prisma\n");

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(true);
  });

  it("is false when neither pnpm-workspace.yaml nor package.json declare a build policy", async () => {
    const dir = await makeTempRoot();
    await writeJson(path.join(dir, "package.json"), { name: "fixture" });

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(false);
  });

  it("is false when neither file exists", async () => {
    const dir = await makeTempRoot();

    await expect(pnpmDeclaresBuiltDependencies(dir)).resolves.toBe(false);
  });
});
