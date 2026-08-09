import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDepVersions, installedZodVersion } from "../../src/cli/dep-versions.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-dep-versions-"));
  cleanup.push(root);
  if (manifest !== undefined) {
    await writeFile(join(root, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  return root;
}

describe("detectDepVersions", () => {
  it("returns bare versions with range prefixes stripped", async () => {
    const root = await fixture({
      dependencies: { next: "^15.3.1", react: "~19.0.0", zod: ">=3.24.0" },
      devDependencies: { typescript: "5.6.2" },
    });
    expect(await detectDepVersions(root, "next")).toEqual({
      frameworkVersion: "15.3.1",
      reactVersion: "19.0.0",
      zodVersion: "3.24.0",
      typescriptVersion: "5.6.2",
    });
  });

  it("maps the detected framework to its own package version", async () => {
    const root = await fixture({ dependencies: { express: "5.0.0", next: "15.0.0" } });
    expect((await detectDepVersions(root, "express")).frameworkVersion).toBe("5.0.0");
    expect((await detectDepVersions(root, "next")).frameworkVersion).toBe("15.0.0");
  });

  it("omits frameworkVersion for an unknown framework", async () => {
    const root = await fixture({ dependencies: { react: "19.0.0" } });
    expect(await detectDepVersions(root, "unknown")).toEqual({ reactVersion: "19.0.0" });
  });

  it("omits keys for absent dependencies instead of sending placeholders", async () => {
    const root = await fixture({ dependencies: { next: "15.0.0" } });
    expect(await detectDepVersions(root, "next")).toEqual({ frameworkVersion: "15.0.0" });
  });

  it("keeps prerelease/build metadata but drops versionless ranges", async () => {
    const root = await fixture({
      dependencies: { next: "15.4.0-canary.3", react: "*", zod: "workspace:^4.0.1", typescript: "latest" },
    });
    expect(await detectDepVersions(root, "next")).toEqual({
      frameworkVersion: "15.4.0-canary.3",
      zodVersion: "4.0.1",
    });
  });

  it("omits digit-bearing non-version specifiers and unwraps npm aliases", async () => {
    const root = await fixture({
      dependencies: {
        react: "catalog:react19", // named catalog, not a version
        zod: "npm:zod-compat@^2.1.0", // npm alias: version after the last "@"
        typescript: "file:../react-18-fork", // path digits are not a version
        next: "https://registry.example.com:8443/next-15.tgz", // port/URL digits either
      },
    });
    expect(await detectDepVersions(root, "next")).toEqual({ zodVersion: "2.1.0" });
  });

  it("prefers dependencies over devDependencies for the same package", async () => {
    const root = await fixture({
      dependencies: { react: "19.0.0" },
      devDependencies: { react: "18.0.0" },
    });
    expect((await detectDepVersions(root, "unknown")).reactVersion).toBe("19.0.0");
  });

  it("never throws: missing or malformed package.json returns {}", async () => {
    expect(await detectDepVersions(await fixture(undefined), "next")).toEqual({});
    expect(await detectDepVersions(await fixture("{ not json"), "next")).toEqual({});
    expect(await detectDepVersions(await fixture({ dependencies: ["not-an-object"] }), "next")).toEqual({});
  });
});

describe("installedZodVersion", () => {
  it("reads the TARGET dir's installed zod, null when absent", async () => {
    const root = await fixture({ dependencies: { zod: "^3.23.8" } });
    // The declared range is not the evidence — the installed tree is.
    expect(await installedZodVersion(root)).toBeNull();
    await mkdir(join(root, "node_modules", "zod"), { recursive: true });
    await writeFile(join(root, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version: "3.23.8" }));
    expect(await installedZodVersion(root)).toBe("3.23.8");
  });
});

describe("installedZodVersion in a hoisted workspace (checker round 1)", () => {
  it("resolves zod at the workspace root from the nested app's resolution chain", async () => {
    const workspace = await fixture(undefined);
    // exports map WITHOUT ./package.json — the manifest must still be read
    // (require.resolve would throw ERR_PACKAGE_PATH_NOT_EXPORTED here).
    await mkdir(join(workspace, "node_modules", "zod"), { recursive: true });
    await writeFile(
      join(workspace, "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", version: "3.23.8", exports: { ".": "./index.js" } }),
    );
    const app = join(workspace, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "web" }));
    expect(await installedZodVersion(app)).toBe("3.23.8");
  });

  it("resolves an exports-mapped zod that does expose ./package.json", async () => {
    const workspace = await fixture(undefined);
    await mkdir(join(workspace, "node_modules", "zod"), { recursive: true });
    await writeFile(
      join(workspace, "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", version: "3.25.76", exports: { ".": "./index.js", "./package.json": "./package.json" } }),
    );
    const app = join(workspace, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "web" }));
    expect(await installedZodVersion(app)).toBe("3.25.76");
  });
});
