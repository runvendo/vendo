import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalVendoInjector,
  localVendoInitArgs,
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

  const packages: Array<{ dir: string; name: string; dependencies?: Record<string, string> }> = [
    {
      dir: "vendo",
      name: "vendoai",
      dependencies: {
        "@vendoai/client": "0.1.0",
        "@vendoai/components": "0.1.0",
        "@vendoai/core": "0.1.0",
        "@vendoai/react": "0.1.0",
        "@vendoai/server": "0.1.0",
        "@vendoai/shell": "0.1.0",
      },
    },
    { dir: "vendo-cli", name: "@vendoai/cli" },
    {
      dir: "vendo-client",
      name: "@vendoai/client",
      dependencies: {
        "@vendoai/components": "0.1.0",
        "@vendoai/core": "0.1.0",
        "@vendoai/react": "0.1.0",
        "@vendoai/server": "0.1.0",
        "@vendoai/shell": "0.1.0",
        "@vendoai/stage": "0.1.0",
      },
    },
    {
      dir: "vendo-components",
      name: "@vendoai/components",
      dependencies: {
        "@vendoai/core": "0.1.0",
      },
    },
    { dir: "vendo-core", name: "@vendoai/core" },
    {
      dir: "vendo-react",
      name: "@vendoai/react",
      dependencies: {
        "@vendoai/core": "0.1.0",
        "@vendoai/stage": "0.1.0",
      },
    },
    {
      dir: "vendo-runtime",
      name: "@vendoai/runtime",
      dependencies: {
        "@vendoai/core": "0.1.0",
      },
    },
    {
      dir: "vendo-server",
      name: "@vendoai/server",
      dependencies: {
        "@vendoai/components": "0.1.0",
        "@vendoai/core": "0.1.0",
        "@vendoai/runtime": "0.1.0",
        "@vendoai/shell": "0.1.0",
        "@vendoai/store": "0.1.0",
        "@vendoai/telemetry": "0.1.0",
      },
    },
    {
      dir: "vendo-shell",
      name: "@vendoai/shell",
      dependencies: {
        "@vendoai/core": "0.1.0",
        "@vendoai/react": "0.1.0",
      },
    },
    {
      dir: "vendo-stage",
      name: "@vendoai/stage",
      dependencies: {
        "@vendoai/core": "0.1.0",
      },
    },
    {
      dir: "vendo-store",
      name: "@vendoai/store",
      dependencies: {
        "@vendoai/core": "0.1.0",
        "@vendoai/runtime": "0.1.0",
      },
    },
    { dir: "vendo-telemetry", name: "@vendoai/telemetry" },
  ];

  for (const pkg of packages) {
    await writeJson(path.join(workspaceRoot, "packages", pkg.dir, "package.json"), {
      name: pkg.name,
      version: "0.1.0",
      type: "module",
      main: "index.js",
      files: ["index.js"],
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    });
    await writeFile(path.join(workspaceRoot, "packages", pkg.dir, "index.js"), "export {};\n");
  }
  await mkdir(path.join(workspaceRoot, "vendor"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "vendor/fluidkit-0.5.0-test.tgz"), "fixture fluidkit");
  return workspaceRoot;
}

async function createTargetRepo(corpusRoot: string, name: string): Promise<string> {
  const context = createRunContext({ corpusRoot });
  const repoDir = context.repoDir(name);
  await writeJson(path.join(repoDir, "package.json"), {
    name,
    packageManager: "pnpm@9.12.0",
    dependencies: {
      "vendoai": "latest",
    },
  });
  return repoDir;
}

function readPackageJson(repoDir: string): Promise<{
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  pnpm: { overrides: Record<string, string> };
}> {
  return readFile(path.join(repoDir, "package.json"), "utf8").then((source) => JSON.parse(source));
}

describe("localVendoInitArgs", () => {
  it("passes the CLI local mode through to later init invocation", async () => {
    const workspaceRoot = await createWorkspace();

    expect(localVendoInitArgs(workspaceRoot)).toEqual(["--local", workspaceRoot]);
  });
});

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
      ["@vendoai/cli", 1],
      ["@vendoai/client", 1],
      ["@vendoai/components", 1],
      ["@vendoai/core", 1],
      ["@vendoai/react", 1],
      ["@vendoai/runtime", 1],
      ["@vendoai/server", 1],
      ["@vendoai/shell", 1],
      ["@vendoai/stage", 1],
      ["@vendoai/store", 1],
      ["@vendoai/telemetry", 1],
      ["vendoai", 1],
    ]);
    await expect(readdir(path.join(repoOne, "vendor"))).resolves.toEqual(expect.arrayContaining([
      "fluidkit-0.5.0-test.tgz",
      "vendoai-0.1.0.tgz",
      "vendoai-cli-0.1.0.tgz",
      "vendoai-client-0.1.0.tgz",
      "vendoai-components-0.1.0.tgz",
      "vendoai-core-0.1.0.tgz",
      "vendoai-react-0.1.0.tgz",
      "vendoai-runtime-0.1.0.tgz",
      "vendoai-server-0.1.0.tgz",
      "vendoai-shell-0.1.0.tgz",
      "vendoai-stage-0.1.0.tgz",
      "vendoai-store-0.1.0.tgz",
      "vendoai-telemetry-0.1.0.tgz",
    ]));
    await expect(readdir(path.join(repoTwo, "vendor"))).resolves.toEqual(expect.arrayContaining([
      "vendoai-0.1.0.tgz",
      "vendoai-cli-0.1.0.tgz",
      "vendoai-client-0.1.0.tgz",
      "vendoai-components-0.1.0.tgz",
      "vendoai-core-0.1.0.tgz",
      "vendoai-react-0.1.0.tgz",
      "vendoai-runtime-0.1.0.tgz",
      "vendoai-server-0.1.0.tgz",
      "vendoai-shell-0.1.0.tgz",
      "vendoai-stage-0.1.0.tgz",
      "vendoai-store-0.1.0.tgz",
      "vendoai-telemetry-0.1.0.tgz",
    ]));

    const pkg = await readPackageJson(repoTwo);
    expect(pkg.dependencies["vendoai"]).toBe("file:vendor/vendoai-0.1.0.tgz");
    expect(pkg.devDependencies["@vendoai/cli"]).toBe("file:vendor/vendoai-cli-0.1.0.tgz");
    for (const name of [
      "@vendoai/cli",
      "@vendoai/client",
      "@vendoai/components",
      "@vendoai/core",
      "@vendoai/react",
      "@vendoai/runtime",
      "@vendoai/server",
      "@vendoai/shell",
      "@vendoai/stage",
      "@vendoai/store",
      "@vendoai/telemetry",
      "vendoai",
    ]) {
      expect(pkg.pnpm.overrides[name]).toMatch(/^file:vendor\/vendoai-/);
    }
    expect(pkg.pnpm.overrides["fluidkit"]).toBe("file:vendor/fluidkit-0.5.0-test.tgz");
  });

  it("runs the host install command and accepts lockfiles that point Vendo packages at local tarballs", async () => {
    const workspaceRoot = await createWorkspace();
    const corpusRoot = await makeTempRoot();
    const repoDir = await createTargetRepo(corpusRoot, "repo-lock");
    const pack: PackWorkspacePackage = async (pkg, opts) => {
      await mkdir(opts.vendorDir, { recursive: true });
      await writeFile(path.join(opts.vendorDir, opts.fileName), `packed ${pkg.name}`);
    };
    const installCalls: string[] = [];
    const injector = createLocalVendoInjector({
      context: createRunContext({ corpusRoot }),
      workspaceRoot,
      pack,
      async buildWorkspace() {},
      async runInstallCommand(command, cwd) {
        installCalls.push(`${command} @ ${cwd}`);
        await writeFile(path.join(cwd, "pnpm-lock.yaml"), [
          "dependencies:",
          "  vendoai:",
          "    specifier: file:vendor/vendoai-0.1.0.tgz",
          "    version: file:vendor/vendoai-0.1.0.tgz",
          "  '@vendoai/server':",
          "    specifier: file:vendor/vendoai-server-0.1.0.tgz",
          "    version: file:vendor/vendoai-server-0.1.0.tgz",
          "",
        ].join("\n"));
      },
    });

    const result = await injector.inject({ name: "repo-lock" });

    expect(result.initArgs).toEqual(["--local", workspaceRoot]);
    expect(installCalls).toEqual([`pnpm install --ignore-workspace @ ${repoDir}`]);
    await expect(readFile(path.join(repoDir, "pnpm-lock.yaml"), "utf8")).resolves.toContain("file:vendor/vendoai-0.1.0.tgz");
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
          "  /vendoai/0.1.0:",
          "    resolution:",
          "      tarball: https://registry.npmjs.org/vendoai/-/vendoai-0.1.0.tgz",
          "",
        ].join("\n"));
      },
    });

    await expect(injector.inject({ name: "repo-registry-lock" })).rejects.toThrow(/pnpm-lock\.yaml.*registry\.npmjs\.org.*Vendo/i);
    await expect(readFile(path.join(repoDir, "package.json"), "utf8")).resolves.toContain("file:vendor/vendoai-0.1.0.tgz");
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
});
