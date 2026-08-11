import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installLocalVendoPackages, LOCAL_DIRECT_DEPENDENCIES, LOCAL_VENDO_PACKAGE_NAMES } from "../src/local-pack.js";
import { tempDir } from "../src/temp-dir.test-util.js";

interface WorkspaceManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const repoDir = fileURLToPath(new URL("../../../", import.meta.url));

async function workspaceManifests(): Promise<Map<string, WorkspaceManifest>> {
  const packagesDir = path.join(repoDir, "packages");
  const manifests = new Map<string, WorkspaceManifest>();
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(packagesDir, entry.name, "package.json"), "utf8"),
      ) as WorkspaceManifest;
      if (manifest.name) manifests.set(manifest.name, manifest);
    } catch {
      // A workspace directory without a package manifest is not part of the graph.
    }
  }
  return manifests;
}

function localWorkspaceDependencies(manifest: WorkspaceManifest): string[] {
  const fields = [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies];
  return fields.flatMap((field) => Object.entries(field ?? {}))
    .filter(([name, spec]) => name.startsWith("@vendoai/") && spec.startsWith("workspace:"))
    .map(([name]) => name);
}

describe("local Vendo package closure", () => {
  it("packs every @vendoai workspace dependency reachable from the umbrella", async () => {
    const manifests = await workspaceManifests();
    const reachable = new Set<string>();
    const pending: string[] = [...LOCAL_DIRECT_DEPENDENCIES];

    while (pending.length > 0) {
      const name = pending.pop()!;
      if (reachable.has(name)) continue;
      reachable.add(name);
      const manifest = manifests.get(name);
      expect(manifest, `${name} must be a workspace package`).toBeDefined();
      pending.push(...localWorkspaceDependencies(manifest!));
    }

    const packed = new Set<string>(LOCAL_VENDO_PACKAGE_NAMES);
    expect([...reachable].filter((name) => !packed.has(name)).sort()).toEqual([]);
    expect(reachable).toContain("@vendoai/mcp");
  });

  // The seam: a local host is snapshotted into corpus/.repos as a LONE
  // directory, so every `workspace:` spec it still carries is one pnpm cannot
  // resolve (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND at the post-injection install).
  // Real host manifests, real workspace, real rewrite — only `pnpm pack` is
  // stubbed, so adding a workspace dependency to a host goes red here.
  it("leaves no workspace: spec in a corpus host's injected manifest", async () => {
    const hostsDir = path.join(repoDir, "corpus/hosts");
    for (const entry of await readdir(hostsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = await tempDir("corpus-host-inject-");
      await copyFile(path.join(hostsDir, entry.name, "package.json"), path.join(target, "package.json"));

      const summary = await installLocalVendoPackages(target, repoDir, {
        packageManagerRoot: target,
        pack: async (_pkg, opts) => {
          await mkdir(opts.vendorDir, { recursive: true });
          await writeFile(path.join(opts.vendorDir, opts.fileName), "");
        },
      });

      const injected = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")) as WorkspaceManifest;
      const specs = [injected.dependencies, injected.devDependencies, injected.peerDependencies, injected.optionalDependencies]
        .flatMap((field) => Object.entries(field ?? {}))
        .filter(([, spec]) => spec.startsWith("workspace:"));
      expect(specs, `${entry.name} keeps unresolvable workspace: specs`).toEqual([]);
      expect(summary.packages).toEqual(expect.arrayContaining([...LOCAL_VENDO_PACKAGE_NAMES]));
    }
  });
});
