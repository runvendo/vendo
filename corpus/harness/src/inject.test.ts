import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalVendoInjector,
  type PackWorkspacePackage,
} from "./inject.js";
import { createRunContext } from "./run-context.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRoot(prefix = "vendo-corpus-inject-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await makeTempRoot("vendo-corpus-workspace-");
  await writeJson(path.join(workspaceRoot, "package.json"), {
    name: "vendo-workspace",
    private: true,
    packageManager: "pnpm@9.12.0",
  });

  const packages: Array<{ dir: string; name: string; version?: string; dependencies?: Record<string, string> }> = [
    {
      dir: "vendo",
      name: "@vendoai/vendo",
      dependencies: {
        "@vendoai/actions": "workspace:*",
        "@vendoai/agent": "workspace:*",
        "@vendoai/apps": "workspace:*",
        "@vendoai/automations": "workspace:*",
        "@vendoai/core": "workspace:*",
        "@vendoai/guard": "workspace:*",
        "@vendoai/store": "workspace:*",
        "@vendoai/telemetry": "workspace:*",
        "@vendoai/ui": "workspace:*",
      },
    },
    { dir: "vendoai", name: "vendoai", dependencies: { "@vendoai/vendo": "workspace:*" } },
    { dir: "actions", name: "@vendoai/actions" },
    { dir: "agent", name: "@vendoai/agent" },
    { dir: "apps", name: "@vendoai/apps" },
    { dir: "automations", name: "@vendoai/automations" },
    { dir: "core", name: "@vendoai/core" },
    { dir: "guard", name: "@vendoai/guard" },
    { dir: "store", name: "@vendoai/store" },
    { dir: "vendo-telemetry", name: "@vendoai/telemetry", version: "0.2.0" },
    { dir: "ui", name: "@vendoai/ui" },
  ];

  for (const pkg of packages) {
    await writeJson(path.join(workspaceRoot, "packages", pkg.dir, "package.json"), {
      name: pkg.name,
      version: pkg.version ?? "0.3.0",
      type: "module",
      main: "index.js",
      files: ["index.js"],
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    });
    await writeFile(path.join(workspaceRoot, "packages", pkg.dir, "index.js"), "export {};\n");
  }
  return workspaceRoot;
}

async function createTargetRepo(corpusRoot: string, name: string): Promise<string> {
  const context = createRunContext({ corpusRoot });
  const repoDir = context.repoDir(name);
  await writeJson(path.join(repoDir, "package.json"), {
    name,
    packageManager: "pnpm@9.12.0",
    dependencies: {
      "@vendoai/vendo": "latest",
      "vendoai": "latest",
    },
  });
  return repoDir;
}

function readPackageJson(repoDir: string): Promise<{
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  pnpm: { overrides: Record<string, string> };
}> {
  return readFile(path.join(repoDir, "package.json"), "utf8").then((source) => JSON.parse(source));
}

function readAnyPackageJson(repoDir: string): Promise<Record<string, unknown>> {
  return readFile(path.join(repoDir, "package.json"), "utf8").then((source) => JSON.parse(source) as Record<string, unknown>);
}

describe("createLocalVendoInjector", () => {
  it("builds and packs workspace packages once per sweep, then reuses tarballs across repos", async () => {
    const workspaceRoot = await createWorkspace();
    const corpusRoot = await makeTempRoot();
    const repoOne = await createTargetRepo(corpusRoot, "repo-one");
    const repoTwo = await createTargetRepo(corpusRoot, "repo-two");
    let buildCount = 0;
    const packCounts = new Map<string, number>();
    const pack: PackWorkspacePackage = async (pkg, opts) => {
      packCounts.set(pkg.name, (packCounts.get(pkg.name) ?? 0) + 1);
      await mkdir(opts.vendorDir, { recursive: true });
      await writeFile(path.join(opts.vendorDir, opts.fileName), `packed ${pkg.name}`);
    };
    const injector = createLocalVendoInjector({
      context: createRunContext({ corpusRoot }),
      workspaceRoot,
      runInstall: false,
      pack,
      async buildWorkspace() {
        buildCount += 1;
      },
    });

    const first = await injector.inject({ name: "repo-one" });
    const second = await injector.inject({ name: "repo-two" });

    expect(first.repoDir).toBe(repoOne);
    expect(second.repoDir).toBe(repoTwo);
    expect(buildCount).toBe(1);
    expect([...packCounts.entries()].sort()).toEqual([
      ["@vendoai/actions", 1],
      ["@vendoai/agent", 1],
      ["@vendoai/apps", 1],
      ["@vendoai/automations", 1],
      ["@vendoai/core", 1],
      ["@vendoai/guard", 1],
      ["@vendoai/store", 1],
      ["@vendoai/telemetry", 1],
      ["@vendoai/ui", 1],
      ["@vendoai/vendo", 1],
      ["vendoai", 1],
    ]);
    await expect(readdir(path.join(repoOne, "vendor"))).resolves.toEqual(expect.arrayContaining([
      "vendoai-0.3.0.tgz",
      "vendoai-actions-0.3.0.tgz",
      "vendoai-agent-0.3.0.tgz",
      "vendoai-apps-0.3.0.tgz",
      "vendoai-automations-0.3.0.tgz",
      "vendoai-core-0.3.0.tgz",
      "vendoai-guard-0.3.0.tgz",
      "vendoai-store-0.3.0.tgz",
      "vendoai-telemetry-0.2.0.tgz",
      "vendoai-ui-0.3.0.tgz",
      "vendoai-vendo-0.3.0.tgz",
    ]));
    await expect(readdir(path.join(repoTwo, "vendor"))).resolves.toEqual(expect.arrayContaining([
      "vendoai-0.3.0.tgz",
      "vendoai-actions-0.3.0.tgz",
      "vendoai-agent-0.3.0.tgz",
      "vendoai-apps-0.3.0.tgz",
      "vendoai-automations-0.3.0.tgz",
      "vendoai-core-0.3.0.tgz",
      "vendoai-guard-0.3.0.tgz",
      "vendoai-store-0.3.0.tgz",
      "vendoai-telemetry-0.2.0.tgz",
      "vendoai-ui-0.3.0.tgz",
      "vendoai-vendo-0.3.0.tgz",
    ]));

    const pkg = await readPackageJson(repoTwo);
    expect(pkg.dependencies["@vendoai/vendo"]).toBe("file:vendor/vendoai-vendo-0.3.0.tgz");
    expect(pkg.dependencies["vendoai"]).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
    for (const name of [
      "@vendoai/actions",
      "@vendoai/agent",
      "@vendoai/apps",
      "@vendoai/automations",
      "@vendoai/core",
      "@vendoai/guard",
      "@vendoai/store",
      "@vendoai/telemetry",
      "@vendoai/ui",
      "@vendoai/vendo",
      "vendoai",
    ]) {
      expect(pkg.pnpm.overrides[name]).toMatch(/^file:vendor\/vendoai-/);
    }
  });

  it("runs a non-frozen host install command and accepts lockfiles that point Vendo packages at local tarballs", async () => {
    const workspaceRoot = await createWorkspace();
    const corpusRoot = await makeTempRoot();
    const repoDir = await createTargetRepo(corpusRoot, "repo-lock");
    const pack: PackWorkspacePackage = async (pkg, opts) => {
      await mkdir(opts.vendorDir, { recursive: true });
      await writeFile(path.join(opts.vendorDir, opts.fileName), `packed ${pkg.name}`);
    };
    const installCalls: string[] = [];
    const notes: string[] = [];
    const injector = createLocalVendoInjector({
      context: createRunContext({ corpusRoot }),
      workspaceRoot,
      pack,
      log(message: string) {
        notes.push(message);
      },
      async buildWorkspace() {},
      async runInstallCommand(command, cwd) {
        installCalls.push(`${command} @ ${cwd}`);
        await writeFile(path.join(cwd, "pnpm-lock.yaml"), [
          "dependencies:",
          "  '@vendoai/vendo':",
          "    specifier: file:vendor/vendoai-vendo-0.3.0.tgz",
          "    version: file:vendor/vendoai-vendo-0.3.0.tgz",
          "  '@vendoai/core':",
          "    specifier: file:vendor/vendoai-core-0.3.0.tgz",
          "    version: file:vendor/vendoai-core-0.3.0.tgz",
          "",
        ].join("\n"));
      },
    });

    const result = await injector.inject({ name: "repo-lock" });

    expect(installCalls).toEqual([
      `pnpm --config.minimumReleaseAge=0 --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile @ ${repoDir}`,
    ]);
    expect(notes.join("\n")).toMatch(/post-injection install.*non-frozen/i);
    await expect(readFile(path.join(repoDir, "pnpm-lock.yaml"), "utf8")).resolves.toContain("file:vendor/vendoai-vendo-0.3.0.tgz");
  });

  it("targets appDir package.json when injecting into monorepo apps", async () => {
    const workspaceRoot = await createWorkspace();
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repoDir = context.repoDir("repo-app");
    const appRoot = path.join(repoDir, "apps/web");
    await writeJson(path.join(repoDir, "package.json"), {
      name: "repo-app",
      private: true,
      packageManager: "pnpm@9.12.0",
    });
    await writeJson(path.join(appRoot, "package.json"), {
      name: "web",
      packageManager: "pnpm@9.12.0",
    });
    const pack: PackWorkspacePackage = async (pkg, opts) => {
      await mkdir(opts.vendorDir, { recursive: true });
      await writeFile(path.join(opts.vendorDir, opts.fileName), `packed ${pkg.name}`);
    };
    const injector = createLocalVendoInjector({
      context,
      workspaceRoot,
      runInstall: false,
      pack,
      async buildWorkspace() {},
    });

    const result = await injector.inject({ name: "repo-app", appDir: "apps/web" });

    expect(result.repoDir).toBe(appRoot);
    await expect(readFile(path.join(appRoot, "package.json"), "utf8")).resolves.toContain('"@vendoai/vendo": "file:vendor/vendoai-vendo-0.3.0.tgz"');
    await expect(readFile(path.join(appRoot, "vendor", "vendoai-vendo-0.3.0.tgz"), "utf8")).resolves.toBe("packed @vendoai/vendo");
    await expect(readFile(path.join(repoDir, "package.json"), "utf8")).resolves.not.toContain("vendoai");
  });

  it("runs pnpm appDir injection installs from the workspace root so workspace and catalog protocols resolve", async () => {
    const workspaceRoot = await createWorkspace();
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repoDir = context.repoDir("repo-workspace-app");
    const appRoot = path.join(repoDir, "apps/web");
    await writeJson(path.join(repoDir, "package.json"), {
      name: "repo-workspace-app",
      private: true,
      packageManager: "pnpm@11.2.1",
      devDependencies: {
        turbo: "catalog:",
      },
    });
    await writeFile(path.join(repoDir, "pnpm-workspace.yaml"), [
      "packages:",
      "  - apps/*",
      "  - packages/*",
      "catalog:",
      "  turbo: 2.9.14",
      "",
    ].join("\n"));
    await writeJson(path.join(appRoot, "package.json"), {
      name: "web",
      private: true,
      dependencies: {
        "@repo/ui": "workspace:*",
        next: "catalog:",
      },
      packageManager: "pnpm@11.2.1",
    });
    await writeJson(path.join(repoDir, "packages/ui/package.json"), {
      name: "@repo/ui",
      version: "1.0.0",
    });
    const installCalls: string[] = [];
    const notes: string[] = [];
    const pack: PackWorkspacePackage = async (pkg, opts) => {
      await mkdir(opts.vendorDir, { recursive: true });
      await writeFile(path.join(opts.vendorDir, opts.fileName), `packed ${pkg.name}`);
    };
    const injector = createLocalVendoInjector({
      context,
      workspaceRoot,
      pack,
      log(message: string) {
        notes.push(message);
      },
      async buildWorkspace() {},
      async runInstallCommand(command, cwd) {
        installCalls.push(`${command} @ ${cwd}`);
        await writeFile(path.join(cwd, "pnpm-lock.yaml"), [
          "importers:",
          "  apps/web:",
          "    dependencies:",
          "      '@vendoai/vendo':",
          "        specifier: file:vendor/vendoai-vendo-0.3.0.tgz",
          "        version: file:apps/web/vendor/vendoai-vendo-0.3.0.tgz",
          "      '@vendoai/core':",
          "        specifier: file:vendor/vendoai-core-0.3.0.tgz",
          "        version: file:apps/web/vendor/vendoai-core-0.3.0.tgz",
          "",
        ].join("\n"));
      },
    });

    const result = await injector.inject({
      name: "repo-workspace-app",
      appDir: "apps/web",
      bootstrap: {
        installCommand: "corepack pnpm install --frozen-lockfile --force --ignore-workspace",
        envTemplate: {},
        buildCommand: "corepack pnpm --ignore-workspace --filter web build",
      },
    });

    expect(result.repoDir).toBe(appRoot);
    expect(installCalls).toEqual([
      `corepack pnpm --config.minimumReleaseAge=0 --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile --force @ ${repoDir}`,
    ]);
    expect(notes.join("\n")).toMatch(/workspace root/i);
    await expect(readFile(path.join(appRoot, "package.json"), "utf8")).resolves.toContain('"@repo/ui": "workspace:*"');
    await expect(readFile(path.join(appRoot, "package.json"), "utf8")).resolves.toContain('"@vendoai/vendo": "file:vendor/vendoai-vendo-0.3.0.tgz"');
    const rootPkg = await readAnyPackageJson(repoDir) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    expect(rootPkg.dependencies?.["vendoai"]).toBeUndefined();
    expect(rootPkg.devDependencies?.["@vendoai/vendo"]).toBeUndefined();
    const workspaceYaml = await readFile(path.join(repoDir, "pnpm-workspace.yaml"), "utf8");
    expect(workspaceYaml).toContain('"@vendoai/core": "file:apps/web/vendor/vendoai-core-0.3.0.tgz"');
    expect(workspaceYaml).toContain('"@vendoai/core@0.3.0": "file:apps/web/vendor/vendoai-core-0.3.0.tgz"');
    expect(workspaceYaml).toContain('"@vendoai/vendo": "file:apps/web/vendor/vendoai-vendo-0.3.0.tgz"');
    expect(workspaceYaml).toContain('"@vendoai/vendo@0.3.0": "file:apps/web/vendor/vendoai-vendo-0.3.0.tgz"');
    expect(workspaceYaml).toContain('"vendoai": "file:apps/web/vendor/vendoai-0.3.0.tgz"');
    expect(rootPkg.pnpm.overrides["@vendoai/core"]).toBe("file:apps/web/vendor/vendoai-core-0.3.0.tgz");
    expect(rootPkg.pnpm.overrides["@vendoai/core@0.3.0"]).toBe("file:apps/web/vendor/vendoai-core-0.3.0.tgz");
    expect(rootPkg.pnpm.overrides["@vendoai/vendo"]).toBe("file:apps/web/vendor/vendoai-vendo-0.3.0.tgz");
    expect(rootPkg.pnpm.overrides["@vendoai/vendo@0.3.0"]).toBe("file:apps/web/vendor/vendoai-vendo-0.3.0.tgz");
  });

  it("rejects lockfiles that still point Vendo packages at the registry", async () => {
    const workspaceRoot = await createWorkspace();
    const corpusRoot = await makeTempRoot();
    const repoDir = await createTargetRepo(corpusRoot, "repo-registry-lock");
    const pack: PackWorkspacePackage = async (pkg, opts) => {
      await mkdir(opts.vendorDir, { recursive: true });
      await writeFile(path.join(opts.vendorDir, opts.fileName), `packed ${pkg.name}`);
    };
    const injector = createLocalVendoInjector({
      context: createRunContext({ corpusRoot }),
      workspaceRoot,
      pack,
      async buildWorkspace() {},
      async runInstallCommand(_command, cwd) {
        await writeFile(path.join(cwd, "pnpm-lock.yaml"), [
          "packages:",
          "  /vendoai/0.3.0:",
          "    resolution:",
          "      tarball: https://registry.npmjs.org/vendoai/-/vendoai-0.3.0.tgz",
          "",
        ].join("\n"));
      },
    });

    await expect(injector.inject({ name: "repo-registry-lock" })).rejects.toThrow(/pnpm-lock\.yaml.*registry\.npmjs\.org.*Vendo/i);
    await expect(readFile(path.join(repoDir, "package.json"), "utf8")).resolves.toContain("file:vendor/vendoai-vendo-0.3.0.tgz");
  });

  it("fails early when the workspace or corpus repo path contains a space", async () => {
    const workspaceRoot = await makeTempRoot("vendo workspace ");
    const corpusRoot = await makeTempRoot();
    await createTargetRepo(corpusRoot, "repo-space");
    const injector = createLocalVendoInjector({
      context: createRunContext({ corpusRoot }),
      workspaceRoot,
      runInstall: false,
      async buildWorkspace() {
        throw new Error("build should not run");
      },
    });

    await expect(injector.inject({ name: "repo-space" })).rejects.toThrow(/local-pack known issue.*spaces/i);
  });

  it("injects Yarn Berry appDir repos from the checkout root without clobbering .yarnrc.yml", async () => {
    const workspaceRoot = await createWorkspace();
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repoDir = context.repoDir("cal-com");
    const appRoot = path.join(repoDir, "apps/web");
    await writeJson(path.join(repoDir, "package.json"), {
      name: "cal-com",
      private: true,
      packageManager: "yarn@4.10.3",
      workspaces: ["apps/*"],
    });
    await writeFile(path.join(repoDir, "yarn.lock"), "__metadata:\n  version: 8\n");
    await writeFile(path.join(repoDir, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    await writeJson(path.join(appRoot, "package.json"), {
      name: "@calcom/web",
      dependencies: {
        next: "16.2.3",
      },
    });
    const pack: PackWorkspacePackage = async (pkg, opts) => {
      await mkdir(opts.vendorDir, { recursive: true });
      await writeFile(path.join(opts.vendorDir, opts.fileName), `packed ${pkg.name}`);
    };
    const installCalls: string[] = [];
    const notes: string[] = [];
    const injector = createLocalVendoInjector({
      context,
      workspaceRoot,
      pack,
      log(message: string) {
        notes.push(message);
      },
      async buildWorkspace() {},
      async runInstallCommand(command, cwd) {
        installCalls.push(`${command} @ ${cwd}`);
        await writeFile(path.join(cwd, "yarn.lock"), [
          '"@vendoai/core@file:apps/web/vendor/vendoai-core-0.3.0.tgz":',
          '  resolution: "@vendoai/core@file:apps/web/vendor/vendoai-core-0.3.0.tgz"',
          '"@vendoai/vendo@file:apps/web/vendor/vendoai-vendo-0.3.0.tgz":',
          '  resolution: "@vendoai/vendo@file:apps/web/vendor/vendoai-vendo-0.3.0.tgz"',
          "",
        ].join("\n"));
      },
    });

    const result = await injector.inject({
      name: "cal-com",
      appDir: "apps/web",
      bootstrap: {
        installCommand: "corepack yarn install --immutable --check-cache",
        envTemplate: {},
        buildCommand: "corepack yarn build",
      },
    });

    expect(result.packageManager).toBe("yarn-berry");
    expect(result.installCommand).toBe("YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install");
    expect(installCalls).toEqual([`YARN_ENABLE_IMMUTABLE_INSTALLS=false corepack yarn install @ ${repoDir}`]);
    expect(notes.join("\n")).toMatch(/post-injection install.*non-frozen/i);
    expect(notes.join("\n")).toMatch(/package-manager root/i);
    await expect(readFile(path.join(repoDir, ".yarnrc.yml"), "utf8")).resolves.toBe("nodeLinker: node-modules\n");
    const pkg = await readAnyPackageJson(appRoot) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
      resolutions: Record<string, string>;
      pnpm?: unknown;
      overrides?: unknown;
    };
    expect(pkg.dependencies["@vendoai/vendo"]).toBe("file:vendor/vendoai-vendo-0.3.0.tgz");
    expect(pkg.dependencies["next"]).toBe("16.2.3");
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.resolutions["@vendoai/vendo"]).toBe("file:vendor/vendoai-vendo-0.3.0.tgz");
    expect(pkg.pnpm).toBeUndefined();
    expect(pkg.overrides).toBeUndefined();
  });

  it("rejects Yarn lockfiles that still resolve Vendo packages from the registry", async () => {
    const workspaceRoot = await createWorkspace();
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repoDir = context.repoDir("repo-yarn-registry-lock");
    await writeJson(path.join(repoDir, "package.json"), {
      name: "repo-yarn-registry-lock",
      private: true,
      packageManager: "yarn@1.22.22",
    });
    await writeFile(path.join(repoDir, "yarn.lock"), "# yarn lockfile v1\n");
    const pack: PackWorkspacePackage = async (pkg, opts) => {
      await mkdir(opts.vendorDir, { recursive: true });
      await writeFile(path.join(opts.vendorDir, opts.fileName), `packed ${pkg.name}`);
    };
    const injector = createLocalVendoInjector({
      context,
      workspaceRoot,
      pack,
      async buildWorkspace() {},
      async runInstallCommand(_command, cwd) {
        await writeFile(path.join(cwd, "yarn.lock"), [
          '"@vendoai/vendo@^0.3.0":',
          '  version "0.3.0"',
          '  resolved "https://registry.yarnpkg.com/@vendoai/vendo/-/vendo-0.3.0.tgz"',
          "",
        ].join("\n"));
      },
    });

    await expect(injector.inject({ name: "repo-yarn-registry-lock" })).rejects.toThrow(/yarn\.lock.*registry.*Vendo/i);
  });
});
