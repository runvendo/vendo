import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { DevCredential, EnvKeyProvider } from "../dev-creds/resolve.js";
import { installedZodVersion } from "./dep-versions.js";
import type { Output } from "./shared.js";

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
    without a local entry). */
async function isInstalled(root: string, moduleName: string): Promise<boolean> {
  try {
    await readFile(join(root, "node_modules", ...moduleName.split("/"), "package.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function fileExists(root: string, name: string): Promise<boolean> {
  try {
    await readFile(join(root, name));
    return true;
  } catch {
    return false;
  }
}

export interface InstallCommand {
  command: string;
  args: string[];
  /** Where to run it. The app dir for pnpm/yarn/bun (they locate their own
      workspace root); the lockfile root for a nested npm-workspace app. */
  cwd: string;
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
      return { command: "pnpm", args: ["add"], cwd: appRoot };
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
