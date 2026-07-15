import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCAL_DIRECT_DEPENDENCIES, LOCAL_VENDO_PACKAGE_NAMES } from "./local-pack.js";

interface WorkspaceManifest {
  name?: string;
  dependencies?: Record<string, string>;
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
});
