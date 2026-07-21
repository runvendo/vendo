import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProviderDeps, installCommandFor, providerModuleFor } from "./provider-deps.js";

// Init installs the provider module the resolved credential loads at
// runtime (0.4.1 E2E cert finding: nothing declares @ai-sdk/*, so a fresh
// install 500s on the first turn until it's installed by hand).

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-provider-deps-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function installModule(root: string, name: string): Promise<void> {
  const dir = join(root, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
}

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) } };
}

describe("providerModuleFor", () => {
  it("maps each credential rung to the module the runtime ladder loads", () => {
    expect(providerModuleFor({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }))
      .toMatchObject({ module: "@ai-sdk/anthropic" });
    expect(providerModuleFor({ rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" }))
      .toMatchObject({ module: "@ai-sdk/openai" });
    // The Cloud gateway is Anthropic-compatible and rides @ai-sdk/anthropic.
    expect(providerModuleFor({ rung: "vendo-cloud" })).toMatchObject({ module: "@ai-sdk/anthropic" });
    expect(providerModuleFor({ rung: "none" })).toBeNull();
  });
});

describe("installCommandFor", () => {
  it("sniffs the lockfile, npm as the fallback", async () => {
    const root = await tempRoot();
    expect(await installCommandFor(root)).toEqual({ command: "npm", args: ["install"] });
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    expect(await installCommandFor(root)).toEqual({ command: "pnpm", args: ["add"] });
  });
});

describe("ensureProviderDeps", () => {
  it("installs ai@^6 + the credential's provider when neither resolves", async () => {
    const root = await tempRoot();
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const messages = output();
    await ensureProviderDeps({
      root,
      credential: { rung: "vendo-cloud" },
      output: messages.sink,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return 0;
      },
    });
    expect(calls).toEqual([{ command: "npm", args: ["install", "ai@^6", "@ai-sdk/anthropic@^3"], cwd: root }]);
    expect(messages.logs.join("\n")).toContain("Installed ai@^6 @ai-sdk/anthropic@^3.");
    expect(messages.errors).toEqual([]);
  });

  it("is a no-op when the host already resolves both modules", async () => {
    const root = await tempRoot();
    await installModule(root, "ai");
    await installModule(root, "@ai-sdk/anthropic");
    const calls: unknown[] = [];
    await ensureProviderDeps({
      root,
      credential: { rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
      output: output().sink,
      run: async (...call) => {
        calls.push(call);
        return 0;
      },
    });
    expect(calls).toEqual([]);
  });

  it("installs only the missing half", async () => {
    const root = await tempRoot();
    await installModule(root, "ai");
    const calls: Array<{ args: string[] }> = [];
    await ensureProviderDeps({
      root,
      credential: { rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" },
      output: output().sink,
      run: async (_command, args) => {
        calls.push({ args });
        return 0;
      },
    });
    expect(calls).toEqual([{ args: ["install", "@ai-sdk/openai@^3"] }]);
  });

  it("does nothing without a credential — there is no provider to install for", async () => {
    const root = await tempRoot();
    const calls: unknown[] = [];
    await ensureProviderDeps({
      root,
      credential: { rung: "none" },
      output: output().sink,
      run: async (...call) => {
        calls.push(call);
        return 0;
      },
    });
    expect(calls).toEqual([]);
  });

  it("degrades to the exact manual command when the install fails, never throws", async () => {
    const root = await tempRoot();
    const messages = output();
    await ensureProviderDeps({
      root,
      credential: { rung: "vendo-cloud" },
      output: messages.sink,
      run: async () => null,
    });
    expect(messages.errors.join("\n")).toContain("npm install ai@^6 @ai-sdk/anthropic@^3");
    expect(messages.errors.join("\n")).toContain("E-DEP-001");
  });
});
