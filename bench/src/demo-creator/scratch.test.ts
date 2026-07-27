import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appBuildCommand,
  appInstallCommand,
  defaultDemoScratchDir,
  extractYamlBlock,
  isStandaloneApp,
  pinWorkspaceDependencies,
  renderCloneDockerignore,
  renderClonePnpmWorkspace,
  tarballFileName,
  vendorWorkspacePackages,
} from "./scratch.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("defaultDemoScratchDir", () => {
  it("is absolute and outside this checkout — the whole point of the leak fix", () => {
    const scratch = defaultDemoScratchDir();
    expect(path.isAbsolute(scratch)).toBe(true);
    expect(path.relative(repoRoot, scratch).startsWith("..")).toBe(true);
  });
});

describe("isStandaloneApp", () => {
  it("distinguishes a workspace member from a scratch clone", () => {
    expect(isStandaloneApp("/repo", "/repo/apps/demo-acme")).toBe(false);
    expect(isStandaloneApp("/repo", "/tmp/vendo-demos/demo-acme")).toBe(true);
    // A sibling whose path merely starts with the repo root's string is NOT inside it.
    expect(isStandaloneApp("/repo", "/repo-other/demo-acme")).toBe(true);
  });
});

describe("tarballFileName", () => {
  it("follows npm's naming so the packed file can be located without parsing pack output", () => {
    expect(tarballFileName("@vendoai/core", "0.4.8")).toBe("vendoai-core-0.4.8.tgz");
    expect(tarballFileName("vendoai", "0.4.8")).toBe("vendoai-0.4.8.tgz");
  });
});

describe("pinWorkspaceDependencies", () => {
  const specs = {
    "@vendoai/core": "file:./vendor/vendoai-core-0.4.8.tgz",
    "@vendoai/guard": "file:./vendor/vendoai-guard-0.4.8.tgz",
  };

  it("repoints every workspace protocol at its vendored tarball and leaves the rest alone", () => {
    const pinned = pinWorkspaceDependencies(
      {
        name: "demo-acme",
        dependencies: { "@vendoai/core": "workspace:*", next: "16.2.9" },
        devDependencies: { "@vendoai/guard": "workspace:^", typescript: "^5" },
      },
      specs,
    );
    expect(pinned["dependencies"]).toEqual({ "@vendoai/core": specs["@vendoai/core"], next: "16.2.9" });
    expect(pinned["devDependencies"]).toEqual({ "@vendoai/guard": specs["@vendoai/guard"], typescript: "^5" });
    expect(pinned["name"]).toBe("demo-acme");
  });

  it("pins the toolchain so the clone does not resolve a pnpm that disagrees with its lockfile", () => {
    const pinned = pinWorkspaceDependencies({ name: "demo-acme" }, specs, { packageManager: "pnpm@11.10.0" });
    expect(pinned["packageManager"]).toBe("pnpm@11.10.0");
  });

  it("fails loudly naming the unvendored dep rather than emitting a broken package.json", () => {
    expect(() =>
      pinWorkspaceDependencies({ dependencies: { "@vendoai/nope": "workspace:*" } }, specs),
    ).toThrow(/@vendoai\/nope/);
  });
});

/**
 * The vendoring is only worth anything if the tarballs carry a build of the
 * CURRENT source — otherwise a demo silently runs package code that disagrees
 * with the checkout, which is precisely what vendoring exists to prevent.
 * `dist/` is gitignored, so "it exists" is not the same as "it is current".
 */
describe("vendorWorkspacePackages build-freshness guard", () => {
  async function fixture(options: { dist?: "fresh" | "stale" | "missing" }): Promise<{ repoRoot: string; appDir: string }> {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "vendo-vendor-"));
    const packageDir = path.join(repoRoot, "packages", "core");
    await mkdir(path.join(packageDir, "src"), { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@vendoai/core", version: "9.9.9", main: "dist/index.js", scripts: { build: "tsc" } }, null, 2)}\n`,
    );
    if (options.dist === "stale") {
      // Output written BEFORE the source it is supposed to be built from.
      await mkdir(path.join(packageDir, "dist"), { recursive: true });
      await writeFile(path.join(packageDir, "dist", "index.js"), "module.exports = {}\n");
      await utimes(path.join(packageDir, "dist", "index.js"), new Date(1_000_000), new Date(1_000_000));
    }
    await writeFile(path.join(packageDir, "src", "index.ts"), "export {}\n");
    if (options.dist === "fresh") {
      await mkdir(path.join(packageDir, "dist"), { recursive: true });
      await writeFile(path.join(packageDir, "dist", "index.js"), "module.exports = {}\n");
    }
    return { repoRoot, appDir: path.join(repoRoot, "clone") };
  }

  it("vendors a package whose dist is newer than its src", async () => {
    const { repoRoot, appDir } = await fixture({ dist: "fresh" });
    await expect(vendorWorkspacePackages({ repoRoot, appDir }))
      .resolves.toEqual({ "@vendoai/core": "file:./vendor/vendoai-core-9.9.9.tgz" });
  }, 30_000);

  it("refuses a package whose src is newer than its dist, naming the fix", async () => {
    const { repoRoot, appDir } = await fixture({ dist: "stale" });
    await expect(vendorWorkspacePackages({ repoRoot, appDir }))
      .rejects.toThrow(/@vendoai\/core.*stale[\s\S]*pnpm build/);
  });

  it("refuses a package with no build output at all", async () => {
    const { repoRoot, appDir } = await fixture({ dist: "missing" });
    await expect(vendorWorkspacePackages({ repoRoot, appDir }))
      .rejects.toThrow(/no build output/);
  });
});

describe("the template's workspace deps stay vendorable", () => {
  it("every one is a publishable packages/* package", async () => {
    const read = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const template = await read(path.join(repoRoot, "apps", "demo-template", "package.json"));
    const ranges = {
      ...(template["dependencies"] as Record<string, string>),
      ...(template["devDependencies"] as Record<string, string>),
    };
    const workspaceDeps = Object.entries(ranges)
      .filter(([, range]) => range.startsWith("workspace:"))
      .map(([name]) => name);
    expect(workspaceDeps.length).toBeGreaterThan(0);

    const publishable = new Set<string>();
    for (const entry of await readdir(path.join(repoRoot, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = await read(path.join(repoRoot, "packages", entry.name, "package.json")).catch(() => undefined);
      if (manifest !== undefined && typeof manifest["name"] === "string" && manifest["private"] !== true) {
        publishable.add(manifest["name"]);
      }
    }
    // If this fails, a scratch clone cannot be made self-contained at all —
    // the template grew a workspace dep that nothing can vendor.
    for (const name of workspaceDeps) expect([...publishable]).toContain(name);
  });
});

describe("extractYamlBlock", () => {
  const document = [
    "packages:",
    '  - "packages/*"',
    "",
    "# a comment about overrides",
    "overrides:",
    '  "next": ">=16.2.11"',
    "  # why this one exists",
    '  "sharp": ">=0.35.0"',
    "",
    "auditConfig:",
    "  ignoreGhsas: []",
  ].join("\n");

  it("lifts one top-level block with its indented body and inline comments", () => {
    expect(extractYamlBlock(document, "overrides")).toBe(
      ['overrides:', '  "next": ">=16.2.11"', "  # why this one exists", '  "sharp": ">=0.35.0"'].join("\n"),
    );
  });

  it("returns undefined for an absent key", () => {
    expect(extractYamlBlock(document, "allowBuilds")).toBeUndefined();
  });
});

describe("renderClonePnpmWorkspace", () => {
  it("carries the repo root's real security floors into the clone", async () => {
    const rendered = renderClonePnpmWorkspace(
      await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
    );
    // The template pins next BELOW the root's floor; without this the clone
    // would silently install the vulnerable version.
    expect(rendered).toContain("overrides:");
    expect(rendered).toContain('"next"');
    expect(rendered).toContain("allowBuilds:");
    // A standalone clone is not a workspace: it must not claim members.
    expect(rendered).not.toContain("packages:");
  });

  // The transitive half of the fidelity fix: pack rewrites a package's own
  // @vendoai deps to registry versions, so without an override the stale
  // published copies reappear underneath the vendored ones.
  it("forces every vendored package through overrides, in ONE overrides mapping", async () => {
    const rendered = renderClonePnpmWorkspace(
      await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
      { "@vendoai/core": "file:./vendor/vendoai-core-0.4.8.tgz" },
    );
    expect(rendered).toContain('"@vendoai/core": "file:./vendor/vendoai-core-0.4.8.tgz"');
    expect(rendered.match(/^overrides:/gm)).toHaveLength(1);
  });

  it("still emits a usable overrides mapping when the root has none", () => {
    const rendered = renderClonePnpmWorkspace("packages:\n  - \"apps/*\"\n", {
      "@vendoai/core": "file:./vendor/vendoai-core-0.4.8.tgz",
    });
    expect(rendered).toContain("overrides:");
    expect(rendered).toContain('"@vendoai/core"');
  });
});

describe("renderCloneDockerignore", () => {
  it("keeps secrets, runtime state and prospect research out of the image", () => {
    const rendered = renderCloneDockerignore();
    for (const excluded of ["node_modules", ".env*", ".vendo/data", "RESEARCH"]) {
      expect(rendered).toContain(excluded);
    }
    // The .vendo contract files (theme/tools/policy/catalog) MUST ship.
    expect(rendered).not.toMatch(/^\.vendo$/m);
  });
});

/**
 * Second line of defence. `demo:create` targets a scratch dir by default, but
 * `--target-dir apps` is still supported for local poking — and THAT clone
 * must be uncommittable, because the failure mode is publishing a named
 * prospect's brand in a public repo.
 */
describe("apps/demo-* gitignore", () => {
  const ignored = (relativePath: string): boolean =>
    spawnSync("git", ["check-ignore", "-q", relativePath], { cwd: repoRoot }).status === 0;

  it("ignores a generated demo anywhere under apps/", () => {
    expect(ignored("apps/demo-acme-widgets/package.json")).toBe(true);
    expect(ignored("apps/demo-acme-widgets/src/app/page.tsx")).toBe(true);
    expect(ignored("apps/demo-acme-widgets/RESEARCH/logo.svg")).toBe(true);
  });

  it("still tracks the three real apps", () => {
    for (const real of ["demo-bank", "demo-accounting", "demo-template"]) {
      expect(ignored(`apps/${real}/package.json`), `apps/${real} must stay tracked`).toBe(false);
    }
  });
});

describe("app command shapes", () => {
  const packageName = "demo-acme";

  it("drives a workspace member from the repo root by filter (unchanged behavior)", () => {
    expect(appBuildCommand({ repoRoot: "/repo", appDir: "/repo/apps/demo-acme", packageName }))
      .toEqual({ command: ["pnpm", "exec", "turbo", "run", "build", "--filter=demo-acme"], cwd: "/repo" });
    expect(appInstallCommand({ repoRoot: "/repo", appDir: "/repo/apps/demo-acme" }))
      .toEqual({ command: ["pnpm", "install"], cwd: "/repo" });
  });

  it("drives a scratch clone from its own directory — there is no workspace to filter", () => {
    const appDir = "/tmp/vendo-demos/demo-acme";
    expect(appBuildCommand({ repoRoot: "/repo", appDir, packageName }))
      .toEqual({ command: ["pnpm", "build"], cwd: appDir });
    expect(appInstallCommand({ repoRoot: "/repo", appDir, extraArgs: ["--lockfile-only"] }))
      .toEqual({ command: ["pnpm", "install", "--lockfile-only"], cwd: appDir });
  });
});
