import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "./process.js";

/**
 * The publish set, packed into tarballs — the same discovery-by-manifest-name
 * rule the corpus harness and the Lane E journey use (`@vendoai/telemetry`
 * lives in `packages/vendo-telemetry`, so directory names cannot be trusted).
 *
 * The stranger installs THESE, never a `workspace:` link and never a source
 * import: a link would resolve the umbrella's inter-package deps through the
 * monorepo, which is the one thing a published install never gets to do.
 */
export const VENDO_PACKAGE_NAMES = [
  "@vendoai/core",
  "@vendoai/store",
  "@vendoai/actions",
  "@vendoai/guard",
  "@vendoai/knowledge",
  "@vendoai/mcp",
  "@vendoai/apps",
  "@vendoai/automations",
  "@vendoai/harnesses",
  "@vendoai/agents",
  "@vendoai/ui",
  "@vendoai/telemetry",
  "@vendoai/vendo",
  "vendoai",
] as const;

/** What the stranger declares itself. Everything else arrives as a transitive
 *  dependency — pinned to a tarball by the overrides, never the registry. */
export const DIRECT_DEPENDENCIES = ["@vendoai/vendo"] as const;

export interface Tarball {
  name: string;
  version: string;
  fileName: string;
}

export interface Packed {
  vendorDir: string;
  tarballs: Tarball[];
}

/** Package name → the version this workspace packed for it. Not one shared
 *  number: `@vendoai/telemetry` versions independently of the umbrella. */
export function packedVersions(packed: Packed): Record<string, string> {
  return Object.fromEntries(packed.tarballs.map((tarball) => [tarball.name, tarball.version]));
}

function npmPackFileName(name: string, version: string): string {
  const base = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
  return `${base}-${version}.tgz`;
}

/** Packs the publish set from the BUILT workspace into destDir. */
export async function packWorkspace(workspaceRoot: string, destDir: string): Promise<Packed> {
  if (workspaceRoot.includes(" ") || destDir.includes(" ")) {
    throw new Error("the install seam needs space-free paths (file: specs)");
  }
  await fs.mkdir(destDir, { recursive: true });

  const byName = new Map<string, { dir: string; version: string }>();
  for (const entry of await fs.readdir(path.join(workspaceRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(workspaceRoot, "packages", entry.name);
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (typeof pkg.name === "string" && typeof pkg.version === "string") {
        byName.set(pkg.name, { dir, version: pkg.version });
      }
    } catch {
      continue;
    }
  }

  const tarballs: Tarball[] = [];
  for (const name of VENDO_PACKAGE_NAMES) {
    const found = byName.get(name);
    if (found === undefined) throw new Error(`workspace is missing publishable package ${name}`);
    const fileName = npmPackFileName(name, found.version);
    await run("pnpm", ["-C", found.dir, "pack", "--pack-destination", destDir], { cwd: workspaceRoot });
    await fs.access(path.join(destDir, fileName));
    tarballs.push({ name, version: found.version, fileName });
  }

  return { vendorDir: destDir, tarballs };
}

/** `file:` specs are relative to the package that declares them. */
export function fileSpec(packed: Packed, name: string): string {
  const tarball = packed.tarballs.find((entry) => entry.name === name);
  if (tarball === undefined) throw new Error(`nothing packed for ${name}`);
  return `file:vendor/${tarball.fileName}`;
}

/**
 * Copies the tarballs into `<target>/vendor` and pins the WHOLE closure.
 *
 * The pin is not optional and it is not cosmetic: `pnpm pack` rewrites the
 * umbrella's `workspace:*` inter-deps to plain versions, which resolve from the
 * npm registry. Without the overrides a stranger would install the umbrella's
 * tarball around twelve PUBLISHED packages and the suite would prove nothing
 * about this commit. pnpm 11 stopped reading `pnpm.overrides` out of
 * package.json, so they go in the scaffold's own pnpm-workspace.yaml.
 */
export async function vendorInto(targetDir: string, packed: Packed): Promise<void> {
  const vendorDir = path.join(targetDir, "vendor");
  await fs.mkdir(vendorDir, { recursive: true });
  for (const tarball of packed.tarballs) {
    await fs.copyFile(path.join(packed.vendorDir, tarball.fileName), path.join(vendorDir, tarball.fileName));
  }
  const overrides = packed.tarballs
    .map((tarball) => `  "${tarball.name}": "file:vendor/${tarball.fileName}"`)
    .join("\n");
  // pnpm 11 fails an install whose dependencies carry unapproved build scripts.
  // These two are the ones the umbrella's tree brings and genuinely needs
  // (esbuild and sharp both fetch a platform binary in theirs), so a real
  // stranger has to approve them too — noted rather than hidden.
  const allowBuilds = ["esbuild", "sharp"].map((name) => `  ${name}: true`).join("\n");
  await fs.writeFile(
    path.join(targetDir, "pnpm-workspace.yaml"),
    `overrides:\n${overrides}\nallowBuilds:\n${allowBuilds}\n`,
  );
}
