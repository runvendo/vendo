import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Standalone (scratch) demo clones — the leak fix.
 *
 * A generated demo carries a prospect's logo, palette, copy and seeded data.
 * While clones landed in `apps/`, one `git add -A` in this OSS checkout
 * published all of it, so `demo:create` now clones into an OS scratch dir by
 * default (`<os-tmp>/vendo-demos/demo-<id>`).
 *
 * That costs the monorepo: the template's deps are `workspace:*`, which only
 * resolve outside this repo to nothing. Three ways out, and the choice matters:
 *
 *  - Symlink the workspace packages. Builds on a laptop, undeployable: a
 *    symlink out of the build context is not something Docker can upload.
 *  - Pin the published `@vendoai/*` versions. Rejected on evidence: main runs
 *    AHEAD of the registry at the same version string (workspace 0.4.8 exports
 *    `vendoModel`, published 0.4.8 does not — a scratch clone pinned that way
 *    fails to build today, and would silently demo a release-old Vendo even
 *    once it did).
 *  - VENDOR the workspace packages as tarballs inside the clone. `pnpm pack`
 *    is ~0.7s per package and ~6MB for all fourteen, the tarballs travel in
 *    the Docker context like any other file, and the demo runs the EXACT Vendo
 *    in this tree. That is what this module does.
 *
 * Overrides, not just direct deps: a packed package's own `@vendoai/*` deps
 * are rewritten to registry versions at pack time, so without a clone-level
 * override the transitive graph would quietly pull the stale published
 * copies back in.
 *
 * An in-repo clone (`--target-dir apps`) is untouched by everything here: it
 * stays a workspace member and every command keeps its original shape.
 */

/** Scratch root for generated demos — outside any git checkout by construction. */
export function defaultDemoScratchDir(): string {
  return path.join(os.tmpdir(), "vendo-demos");
}

/** True when `appDir` lives outside the repo checkout, i.e. it must be self-contained. */
export function isStandaloneApp(repoRoot: string, appDir: string): boolean {
  return path.relative(repoRoot, appDir).startsWith("..");
}

/** package name → dependency spec the clone should use, e.g.
 * `{"@vendoai/core": "file:./vendor/vendoai-core-0.4.8.tgz"}`. */
export type CloneSpecs = Record<string, string>;

/** Where vendored tarballs live inside a clone. */
export const vendorDirName = "vendor";

/** npm's tarball naming, which pnpm follows: `@vendoai/core@0.4.8` →
 * `vendoai-core-0.4.8.tgz`. */
export function tarballFileName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

const execFileAsync = promisify(execFile);

/** Newest file mtime anywhere under `dir`, or undefined if it does not exist
 * or holds no files. */
async function newestMtimeMs(dir: string): Promise<number | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined; // no such directory
  }
  let newest: number | undefined;
  const consider = (candidate: number | undefined): void => {
    if (candidate !== undefined && (newest === undefined || candidate > newest)) newest = candidate;
  };
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      consider(await newestMtimeMs(full));
    } else if (entry.isFile()) {
      consider((await stat(full).catch(() => undefined))?.mtimeMs);
    }
  }
  return newest;
}

/**
 * A clone is only "the exact Vendo in this tree" if the tarballs carry a build
 * of the CURRENT source. `pnpm pack` ships whatever is on disk and `dist/` is
 * gitignored, so a branch switch or an unbuilt edit leaves output that merely
 * EXISTS — the demo would then run package code that does not match the
 * checkout, silently, which is the exact failure this whole approach exists to
 * avoid. Compare newest-source against newest-output and refuse rather than
 * vendor something stale.
 */
export async function assertFreshBuild(name: string, packageDir: string): Promise<void> {
  const distMtime = await newestMtimeMs(path.join(packageDir, "dist"));
  if (distMtime === undefined) {
    throw new Error(
      `Cannot vendor "${name}": no build output in ${packageDir}/dist. Run \`pnpm build\` before creating a `
      + "standalone demo clone — a clone vendors the built packages, not their sources.",
    );
  }
  const srcMtime = await newestMtimeMs(path.join(packageDir, "src"));
  if (srcMtime !== undefined && srcMtime > distMtime) {
    throw new Error(
      `Cannot vendor "${name}": ${packageDir}/src is newer than its dist/, so the build output is stale. `
      + "Run `pnpm build` before creating a standalone demo clone — otherwise the demo would run package code "
      + "that does not match this checkout.",
    );
  }
}

/**
 * Packs every publishable workspace package into `<appDir>/vendor/` and
 * returns the `file:` spec for each. Packing takes whatever is on disk, so
 * every buildable package is checked for present AND current output first
 * ({@link assertFreshBuild}) — an unbuilt tree would otherwise produce
 * tarballs missing their entry points, and a stale one would produce tarballs
 * that quietly disagree with the checkout.
 */
/** One publishable workspace package, as vendoring sees it. */
interface VendorablePackage {
  name: string;
  version: string;
  packageDir: string;
  buildable: boolean;
}

async function publishableWorkspacePackages(repoRoot: string): Promise<VendorablePackage[]> {
  const packagesDir = path.join(repoRoot, "packages");
  const found: VendorablePackage[] = [];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(packagesDir, entry.name);
    let parsed: { name?: unknown; version?: unknown; private?: unknown; scripts?: Record<string, unknown> };
    try {
      parsed = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const { name, version } = parsed;
    if (typeof name !== "string" || typeof version !== "string" || parsed.private === true) continue;
    found.push({ name, version, packageDir, buildable: parsed.scripts?.["build"] !== undefined });
  }
  return found;
}

/**
 * Every freshness check, run as ONE up-front gate.
 *
 * Separated from the packing so `demo:create` can call it BEFORE it copies the
 * template: a stale package must fail while nothing exists on disk yet. Run
 * mid-clone instead, it aborts having already written a prospect-branded
 * config and some tarballs, and the next attempt hits "refusing to overwrite" —
 * a failure that poisons its own retry.
 */
export async function assertWorkspacePacksFresh(repoRoot: string): Promise<void> {
  for (const entry of await publishableWorkspacePackages(repoRoot)) {
    if (entry.buildable) await assertFreshBuild(entry.name, entry.packageDir);
  }
}

export async function vendorWorkspacePackages(options: {
  repoRoot: string;
  appDir: string;
}): Promise<CloneSpecs> {
  const vendorDir = path.join(options.appDir, vendorDirName);
  await mkdir(vendorDir, { recursive: true });
  const specs: CloneSpecs = {};
  for (const { name, version, packageDir, buildable } of await publishableWorkspacePackages(options.repoRoot)) {
    // Re-checked here as well as in the up-front gate: this function is
    // exported and callable on its own, and it must never vendor stale output
    // just because someone skipped the gate.
    if (buildable) await assertFreshBuild(name, packageDir);
    await execFileAsync("pnpm", ["pack", "--pack-destination", vendorDir], { cwd: packageDir });
    const tarball = tarballFileName(name, version);
    if (!existsSync(path.join(vendorDir, tarball))) {
      throw new Error(`\`pnpm pack\` did not produce "${tarball}" for ${name} — expected it in ${vendorDir}`);
    }
    specs[name] = `file:./${vendorDirName}/${tarball}`;
  }
  return specs;
}

function pinSection(
  section: Record<string, string> | undefined,
  specs: CloneSpecs,
  unresolved: string[],
): Record<string, string> | undefined {
  if (section === undefined) return undefined;
  const pinned: Record<string, string> = {};
  for (const [name, range] of Object.entries(section)) {
    if (!range.startsWith("workspace:")) {
      pinned[name] = range;
      continue;
    }
    const spec = specs[name];
    if (spec === undefined) {
      unresolved.push(name);
      continue;
    }
    pinned[name] = spec;
  }
  return pinned;
}

/**
 * Repoints every `workspace:*` dependency at its vendored tarball. Throws
 * naming the offenders rather than emitting a package.json that fails to
 * install with a pnpm error nobody can trace back to here.
 */
export function pinWorkspaceDependencies(
  packageJson: Record<string, unknown>,
  specs: CloneSpecs,
  options: { packageManager?: string } = {},
): Record<string, unknown> {
  const unresolved: string[] = [];
  const dependencies = pinSection(packageJson["dependencies"] as Record<string, string> | undefined, specs, unresolved);
  const devDependencies = pinSection(packageJson["devDependencies"] as Record<string, string> | undefined, specs, unresolved);
  if (unresolved.length > 0) {
    throw new Error(
      `Cannot make a standalone demo clone: nothing vendored for ${unresolved.join(", ")}. `
      + "Every workspace dependency of apps/demo-template must be a publishable packages/* package.",
    );
  }
  return {
    ...packageJson,
    // Pin the toolchain too — the clone installs outside the monorepo, so it
    // no longer inherits the root's packageManager and could resolve a pnpm
    // that disagrees with the lockfile it just wrote.
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
  };
}

/**
 * Lifts one top-level block out of a YAML document, comments and all. Used
 * instead of a YAML parser+serializer so the copied blocks stay byte-identical
 * to the root file (including the comments that explain WHY each override
 * exists) and bench gains no dependency. A block runs from its `key:` line at
 * column 0 to the next column-0 line that isn't blank or a comment.
 */
export function extractYamlBlock(document: string, key: string): string | undefined {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.startsWith("#") || line.startsWith(" ")) continue;
    end = index;
    break;
  }
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

/**
 * The clone's own `pnpm-workspace.yaml`. Three jobs:
 *
 *  - carry the root's `overrides`, which are SECURITY FLOORS (next, next-auth,
 *    sharp, postcss, fast-uri) — the template pins next below its floor;
 *  - carry `allowBuilds`, without which pnpm 11's strictDepBuilds refuses the
 *    deps that need build scripts;
 *  - force every `@vendoai/*` to its vendored tarball, TRANSITIVELY. Direct
 *    deps alone are not enough: pack rewrites a package's own workspace deps
 *    to registry versions, so the stale published copies would come back in
 *    through the graph.
 */
export function renderClonePnpmWorkspace(rootWorkspaceYaml: string, vendorSpecs: CloneSpecs = {}): string {
  const rootOverrides = extractYamlBlock(rootWorkspaceYaml, "overrides");
  const vendored = Object.entries(vendorSpecs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]) => `  "${name}": "${spec}"`);
  // One mapping — YAML cannot carry two `overrides:` keys.
  const overrides = [
    rootOverrides ?? "overrides:",
    ...(vendored.length === 0
      ? []
      : ["  # Vendored from the monorepo at create time, transitively forced.", ...vendored]),
  ].join("\n");
  const allowBuilds = extractYamlBlock(rootWorkspaceYaml, "allowBuilds");
  return `# Generated by \`demo:create\` — a standalone demo clone is not a workspace
# member, so it cannot inherit the monorepo root's settings. The security
# floors and the build allowlist are copied VERBATIM from the repo root's
# pnpm-workspace.yaml; the @vendoai/* entries pin this demo to the exact Vendo
# the monorepo was at when it was generated.
${[overrides, allowBuilds].filter((block) => block !== undefined).join("\n\n")}
`;
}

/** Build context for a standalone deploy is the app dir itself, so a
 * clone-local .dockerignore is the real exclusion mechanism (the repo root's
 * is out of scope). Mirrors the root one: no secrets, no runtime state, no
 * prospect research in the image. */
export function renderCloneDockerignore(): string {
  return `# Generated by \`demo:create\` — the standalone deploy uploads THIS directory
# as the Docker build context, so this file (not the repo root's) is what
# keeps secrets, runtime state and prospect research out of the image.
node_modules
.next
.turbo
*.tsbuildinfo
.env*
.vendo/data
RESEARCH
docs/verification
timings.json
`;
}

/** The build the rewrite stage runs between repair rounds. In-repo keeps the
 * turbo filter (cache hits across the monorepo); standalone is a plain build. */
export function appBuildCommand(options: {
  repoRoot: string;
  appDir: string;
  packageName: string;
}): { command: string[]; cwd: string } {
  if (isStandaloneApp(options.repoRoot, options.appDir)) {
    return { command: ["pnpm", "build"], cwd: options.appDir };
  }
  return {
    command: ["pnpm", "exec", "turbo", "run", "build", `--filter=${options.packageName}`],
    cwd: options.repoRoot,
  };
}

/** Where dependencies get installed for this app: the workspace root for a
 * member, the clone itself for a standalone. */
export function appInstallCommand(options: {
  repoRoot: string;
  appDir: string;
  extraArgs?: readonly string[];
}): { command: string[]; cwd: string } {
  const extra = options.extraArgs ?? [];
  return isStandaloneApp(options.repoRoot, options.appDir)
    ? { command: ["pnpm", "install", ...extra], cwd: options.appDir }
    : { command: ["pnpm", "install", ...extra], cwd: options.repoRoot };
}
