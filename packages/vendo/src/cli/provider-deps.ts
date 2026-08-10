import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DevCredential, EnvKeyProvider } from "../dev-creds/resolve.js";
import { installedVersion, installedZodVersion } from "./dep-versions.js";
import { CLI_VERSION, type Output } from "./shared.js";

/**
 * The starter model ladder resolves its provider from the HOST's
 * node_modules at runtime (dev-creds/model.ts) — nothing declares
 * `@ai-sdk/*` as a dependency, so a fresh install 500s on the first turn
 * until the user reads the dev-server error and installs it by hand (0.4.1
 * E2E certification finding). Init knows the resolved credential, so it can
 * install exactly the provider that credential needs, up front.
 */

const PROVIDER_SPECS: Record<EnvKeyProvider, { module: string; spec: string }> = {
  anthropic: { module: "@ai-sdk/anthropic", spec: "@ai-sdk/anthropic@^3" },
  openai: { module: "@ai-sdk/openai", spec: "@ai-sdk/openai@^3" },
  google: { module: "@ai-sdk/google", spec: "@ai-sdk/google@^3" },
};
const AI_SPEC = "ai@^6";

/** Which provider module the resolved credential will load at runtime.
    The Vendo Cloud gateway speaks the Anthropic-compatible /messages API
    through the host-installed @ai-sdk/anthropic (dev-creds/model.ts). */
export function providerModuleFor(credential: DevCredential): { module: string; spec: string } | null {
  if (credential.rung === "env-key") return PROVIDER_SPECS[credential.provider];
  if (credential.rung === "vendo-cloud") return PROVIDER_SPECS.anthropic;
  return null;
}

/** Resolvability is what the runtime ladder checks, so node_modules is the
    evidence — not package.json (a hoisting monorepo satisfies the import
    without a local entry). `installedVersion` walks the node_modules chain
    upward the way node resolves a bare specifier, so a hoisted workspace
    install is seen where `ai` sees it; a fixed root path called it missing and
    made init shell a package install the tree already satisfied. */
async function isInstalled(root: string, moduleName: string): Promise<boolean> {
  return (await installedVersion(root, moduleName)) !== null;
}

async function readIfExists(root: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(root, name), "utf8");
  } catch {
    return null;
  }
}

async function fileExists(root: string, name: string): Promise<boolean> {
  return (await readIfExists(root, name)) !== null;
}

export interface InstallCommand {
  command: string;
  args: string[];
  /** Where to run it. The app dir for pnpm/yarn/bun (they locate their own
      workspace root); the lockfile root for a nested npm-workspace app. */
  cwd: string;
}

/** The `packages:` globs of a pnpm-workspace.yaml, or null when the block is
    not in the plain block-sequence form this reader understands. A missing
    `packages:` key is an empty member list, which is what pnpm does with a
    settings-only workspace file. */
function workspacePackageGlobs(manifest: string): string[] | null {
  const lines = manifest.split("\n");
  const start = lines.findIndex((line) => /^packages:\s*(#.*)?$/.test(line));
  if (start === -1) return /^packages:/m.test(manifest) ? null : [];
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const entry = /^\s*-\s+(.*)$/.exec(line);
    if (entry === null) break;
    globs.push((entry[1] as string).replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return globs;
}

/** The `*` / `**` / `?` subset of pnpm's package patterns, or null for a
    pattern using brace/extglob syntax this does not model. */
function globToRegExp(pattern: string): RegExp | null {
  if (/[{}()[\]+@|!]/.test(pattern)) return null;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.\\^$+?()[\]{}|]/, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Whether a workspace root's `packages:` globs claim this relative path.
    Anything unreadable counts as a member — the conservative answer, since a
    member is what init already treats every nested app as today. */
function workspaceClaims(manifest: string, relativePath: string): boolean {
  const globs = workspacePackageGlobs(manifest);
  if (globs === null) return true;
  const path = relativePath.split(sep).join("/");
  let claimed = false;
  for (const glob of globs) {
    const negated = glob.startsWith("!");
    const pattern = globToRegExp(negated ? glob.slice(1) : glob);
    if (pattern === null) return true;
    if (!pattern.test(path)) continue;
    if (negated) return false;
    claimed = true;
  }
  return claimed;
}

/** True when the host is an independent pnpm project sitting INSIDE someone
    else's pnpm workspace — a repo cloned into an unrelated monorepo. pnpm
    picks its workspace root by walking up to the nearest
    `pnpm-workspace.yaml`, so an unqualified `pnpm add` there installs against
    the ANCESTOR: under pnpm 11 the ancestor's overrides rewrite the host's
    own pins (this repo's `next: ">=16.2.11"` gave a host pinning 14.2.5 a
    next 16 tree), and under pnpm 9 the add aborts on the ancestor's store
    (ERR_PNPM_UNEXPECTED_STORE), so the repair never happens at all.
    Membership is the workspace's own answer — its `packages:` globs — not the
    presence of a leaf lockfile: a real member can carry a stale or copied one,
    and cutting it loose would write the repair to that leaf instead of the
    workspace. An app that is its own workspace root already wins pnpm's walk. */
async function nestedOutsidePnpmWorkspace(appRoot: string): Promise<boolean> {
  if (await fileExists(appRoot, "pnpm-workspace.yaml")) return false;
  for (let dir = dirname(appRoot); ; dir = dirname(dir)) {
    const manifest = await readIfExists(dir, "pnpm-workspace.yaml");
    if (manifest !== null) return !workspaceClaims(manifest, relative(dir, appRoot));
    if (dirname(dir) === dir) return false;
  }
}

/** Lockfile-sniffed installer, resolved the way package managers resolve
    their own root: walk UP from the app dir to the NEAREST lockfile or
    workspace marker. A nested workspace app usually carries neither in its
    own dir — sniffing only there fell back to npm and the printed/run
    command would mint a conflicting package-lock.json inside the app.
    npm stays the no-evidence fallback. */
export async function installCommandFor(root: string): Promise<InstallCommand> {
  const appRoot = resolve(root);
  for (let dir = appRoot; ; dir = dirname(dir)) {
    if ((await fileExists(dir, "pnpm-lock.yaml")) || (await fileExists(dir, "pnpm-workspace.yaml"))) {
      const args = (await nestedOutsidePnpmWorkspace(appRoot)) ? ["add", "--ignore-workspace"] : ["add"];
      return { command: "pnpm", args, cwd: appRoot };
    }
    if (await fileExists(dir, "yarn.lock")) return { command: "yarn", args: ["add"], cwd: appRoot };
    if ((await fileExists(dir, "bun.lockb")) || (await fileExists(dir, "bun.lock"))) {
      return { command: "bun", args: ["add"], cwd: appRoot };
    }
    if (await fileExists(dir, "package-lock.json")) {
      // npm workspaces: install from the lockfile root targeting the app
      // package, or npm writes a second, conflicting lockfile in the app dir.
      return dir === appRoot
        ? { command: "npm", args: ["install"], cwd: appRoot }
        : { command: "npm", args: ["install", "--workspace", relative(dir, appRoot)], cwd: dir };
    }
    if (dirname(dir) === dir) return { command: "npm", args: ["install"], cwd: appRoot };
  }
}

/** The exact command line a human can paste — prefixed with a `cd` when the
    install must run somewhere other than the app dir. */
function invocationFor(install: InstallCommand, specs: string[], appRoot: string): string {
  const line = `${install.command} ${[...install.args, ...specs].join(" ")}`;
  return resolve(install.cwd) === resolve(appRoot) ? line : `(cd ${install.cwd} && ${line})`;
}

/** The paste-ready zod bump for this host's package manager and workspace
    shape — shared by init's print path and doctor's E-DEP-003 story. */
export async function zodBumpInvocation(root: string): Promise<string> {
  return invocationFor(await installCommandFor(root), [ZOD_FLOOR_SPEC], root);
}

/** Test seam: resolves to the child's exit code (null on spawn error). */
export type InstallRunner = (command: string, args: string[], cwd: string) => Promise<number | null>;

const INSTALL_TIMEOUT_MS = 240_000;

const defaultRunner: InstallRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, INSTALL_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

export interface EnsureProviderDepsOptions {
  root: string;
  credential: DevCredential;
  output: Output;
  run?: InstallRunner;
}

/** Installs `ai@^6` + the credential's provider when the host can't resolve
    them. Never fatal: a failed install degrades to the exact manual command
    (the same one doctor's E-DEP-001 story names). */
export async function ensureProviderDeps(options: EnsureProviderDepsOptions): Promise<void> {
  const provider = providerModuleFor(options.credential);
  if (provider === null) return;

  const specs: string[] = [];
  if (!(await isInstalled(options.root, "ai"))) specs.push(AI_SPEC);
  if (!(await isInstalled(options.root, provider.module))) specs.push(provider.spec);
  if (specs.length === 0) return;

  const install = await installCommandFor(options.root);
  const invocation = invocationFor(install, specs, options.root);
  options.output.log(`Installing the model provider this credential uses: ${specs.join(" ")} (${install.command})…`);
  const code = await (options.run ?? defaultRunner)(install.command, [...install.args, ...specs], install.cwd);
  if (code === 0) {
    options.output.log(`Installed ${specs.join(" ")}.`);
  } else {
    options.output.error(
      `warning: could not install ${specs.join(" ")} — run \`${invocation}\` yourself before the first turn, or it fails at runtime (E-DEP-001).`,
    );
  }
}

/** The package every scaffold imports, pinned to the CLI that wrote them — the
    same spec doctor's E-DEP-002 story names, so the repair can never mint the
    split-brain install that check warns about. */
export const VENDO_PACKAGE_SPEC = `@vendoai/vendo@${CLI_VERSION}`;

/** The paste-ready `@vendoai/vendo` install for this host's package manager
    and workspace shape — shared by init's failed-repair warning and doctor's
    E-WIRE-011 story. */
export async function vendoPackageInvocation(root: string): Promise<string> {
  return invocationFor(await installCommandFor(root), [VENDO_PACKAGE_SPEC], root);
}

/**
 * #1153: every scaffold imports `@vendoai/vendo/*`, but a host whose only
 * direct dependency is the `vendoai` alias keeps that package inside the
 * alias's OWN nested resolution. Under pnpm's strict node_modules host source
 * may only resolve its direct dependencies, so the wired route never compiles
 * ("Module not found: Can't resolve '@vendoai/vendo/server'") and every route
 * 500s — a failure the live probes can only report as an unreachable server.
 * Init wrote those imports, so init makes them resolvable, exactly as it does
 * for the provider the first turn loads.
 *
 * Resolvability is the evidence, never package.json: a hoisting installer
 * (npm, yarn) already satisfies the import through the alias's own dependency,
 * and a host that has installed nothing yet is not this repair's business —
 * its own install is the next thing to run.
 */
export async function ensureVendoPackage(options: { root: string; output: Output; run?: InstallRunner }): Promise<void> {
  if (await isInstalled(options.root, "@vendoai/vendo")) return;
  if (!(await isInstalled(options.root, "vendoai"))) return;

  const install = await installCommandFor(options.root);
  options.output.log(`Installing the package your wiring imports: ${VENDO_PACKAGE_SPEC} (${install.command})…`);
  const code = await (options.run ?? defaultRunner)(install.command, [...install.args, VENDO_PACKAGE_SPEC], install.cwd);
  if (code === 0) {
    options.output.log(`Installed ${VENDO_PACKAGE_SPEC}.`);
  } else {
    options.output.error(
      `warning: could not install ${VENDO_PACKAGE_SPEC} — the wiring imports @vendoai/vendo/* and the vendoai alias keeps its copy nested, so the route will not compile; run \`${await vendoPackageInvocation(options.root)}\` yourself (E-WIRE-011).`,
    );
  }
}

/** The bump that satisfies the AI SDK's zod floor while keeping zod 3
    semantics — ai@6 imports the `zod/v3` + `zod/v4` subpaths that arrive in
    zod 3.25, and ^3.25.0 still satisfies the common `^3.2x` host ranges. */
export const ZOD_FLOOR_SPEC = "zod@^3.25.0";

/** True when an installed zod predates the AI SDK's subpath imports
    (FINDINGS F2). zod 4 exposes them too, so only pre-3.25 threes (and
    anything older) are below the floor. */
export function zodBelowAiSdkFloor(version: string): boolean {
  const [major = Number.NaN, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (Number.isNaN(major)) return false;
  return major < 3 || (major === 3 && (Number.isNaN(minor) || minor < 25));
}

export interface EnsureZodFloorOptions {
  root: string;
  output: Output;
  /** Interactive consent (init's confirm shape). Absent without `yes`, the
      bump is never performed — the exact command is printed instead. */
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** --yes: perform the bump without the ask. */
  yes?: boolean;
  run?: InstallRunner;
}

/**
 * FINDINGS F2 (skateshop): installing Vendo onto a host pinning zod < 3.25
 * turns a green build red — ai@6 imports the `zod/v3` + `zod/v4` subpaths
 * that arrive in 3.25, and the host's own older pin wins the installed tree
 * no matter what the vendo packages declare. Init is where the host's deps
 * are already being managed, so the floor is surfaced (and, with consent,
 * fixed) here. Never a silent mutation: interactive runs ask, --yes performs
 * the announced bump, and a non-interactive run without --yes only prints
 * the exact command (the same story doctor's E-DEP-003 tells).
 */
export async function ensureZodFloor(options: EnsureZodFloorOptions): Promise<void> {
  const version = await installedZodVersion(options.root);
  if (version === null || !zodBelowAiSdkFloor(version)) return;

  const install = await installCommandFor(options.root);
  const invocation = invocationFor(install, [ZOD_FLOOR_SPEC], options.root);
  const problem = `installed zod@${version} predates the zod/v3 + zod/v4 subpaths the AI SDK imports (needs >=3.25), so the app build fails inside ai@6`;
  if (options.yes !== true) {
    if (options.confirm === undefined) {
      options.output.error(`warning: ${problem} — run \`${invocation}\` (^3.25.0 keeps zod 3 semantics; E-DEP-003).`);
      return;
    }
    if (!(await options.confirm(`Your ${problem}. Bump to zod@^3.25.0 now (stays within zod 3)?`, true))) {
      options.output.error(`warning: ${problem} — run \`${invocation}\` before building (E-DEP-003).`);
      return;
    }
  }
  options.output.log(`Bumping zod to the AI SDK floor: ${ZOD_FLOOR_SPEC} (${install.command})…`);
  const code = await (options.run ?? defaultRunner)(install.command, [...install.args, ZOD_FLOOR_SPEC], install.cwd);
  if (code === 0) {
    options.output.log(`Installed ${ZOD_FLOOR_SPEC}.`);
  } else {
    options.output.error(`warning: could not install ${ZOD_FLOOR_SPEC} — run \`${invocation}\` yourself, or the build fails (E-DEP-003).`);
  }
}
