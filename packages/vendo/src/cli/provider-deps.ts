import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DevCredential, EnvKeyProvider } from "../dev-creds/resolve.js";
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

/** Lockfile-sniffed installer; npm is the fallback. */
export async function installCommandFor(root: string): Promise<{ command: string; args: string[] }> {
  if (await fileExists(root, "pnpm-lock.yaml")) return { command: "pnpm", args: ["add"] };
  if (await fileExists(root, "yarn.lock")) return { command: "yarn", args: ["add"] };
  if ((await fileExists(root, "bun.lockb")) || (await fileExists(root, "bun.lock"))) {
    return { command: "bun", args: ["add"] };
  }
  return { command: "npm", args: ["install"] };
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

  const { command, args } = await installCommandFor(options.root);
  const invocation = `${command} ${[...args, ...specs].join(" ")}`;
  options.output.log(`Installing the model provider this credential uses: ${specs.join(" ")} (${command})…`);
  const code = await (options.run ?? defaultRunner)(command, [...args, ...specs], options.root);
  if (code === 0) {
    options.output.log(`Installed ${specs.join(" ")}.`);
  } else {
    options.output.error(
      `warning: could not install ${specs.join(" ")} — run \`${invocation}\` yourself before the first turn, or it fails at runtime (E-DEP-001).`,
    );
  }
}
