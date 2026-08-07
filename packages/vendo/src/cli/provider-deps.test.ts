import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProviderDeps, ensureZodFloor, installCommandFor, providerModuleFor, zodBelowAiSdkFloor, ZOD_FLOOR_SPEC } from "./provider-deps.js";

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
    expect(await installCommandFor(root)).toEqual({ command: "npm", args: ["install"], cwd: root });
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    expect(await installCommandFor(root)).toEqual({ command: "pnpm", args: ["add"], cwd: root });
  });

  it("walks up to the workspace's pnpm marker from a nested app dir", async () => {
    // A nested workspace app has no lockfile of its own; sniffing only the
    // app dir used to fall back to npm and mint a conflicting package-lock.
    const workspace = await tempRoot();
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");
    const app = join(workspace, "apps", "web");
    await mkdir(app, { recursive: true });
    expect(await installCommandFor(app)).toEqual({ command: "pnpm", args: ["add"], cwd: app });
  });

  it("targets a nested npm-workspace app from the lockfile root", async () => {
    const workspace = await tempRoot();
    await writeFile(join(workspace, "package-lock.json"), "{}");
    const app = join(workspace, "apps", "web");
    await mkdir(app, { recursive: true });
    expect(await installCommandFor(app)).toEqual({
      command: "npm",
      args: ["install", "--workspace", join("apps", "web")],
      cwd: workspace,
    });
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

// FINDINGS F2 (skateshop): a host pinning zod < 3.25 builds red once init's
// wiring pulls ai@6 into the bundle — ai imports the zod/v3 + zod/v4
// subpaths that arrive in zod 3.25, and the host's own pin wins the
// installed tree. Init surfaces the floor and bumps only with consent.

async function installZodVersion(root: string, version: string): Promise<void> {
  const dir = join(root, "node_modules", "zod");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "zod", version }));
}

describe("zodBelowAiSdkFloor", () => {
  it("draws the line at 3.25, where the zod/v3 + zod/v4 subpaths arrive", () => {
    expect(zodBelowAiSdkFloor("3.23.8")).toBe(true);
    expect(zodBelowAiSdkFloor("3.24.0")).toBe(true);
    expect(zodBelowAiSdkFloor("2.9.9")).toBe(true);
    expect(zodBelowAiSdkFloor("3.25.0")).toBe(false);
    expect(zodBelowAiSdkFloor("3.25.76")).toBe(false);
    // zod 4 exposes both subpaths (umami) — never flagged, never downgraded.
    expect(zodBelowAiSdkFloor("4.1.8")).toBe(false);
    // An unparseable version is not evidence of an old zod.
    expect(zodBelowAiSdkFloor("not-a-version")).toBe(false);
  });
});

describe("ensureZodFloor", () => {
  it("bumps without asking under --yes, announcing the change", async () => {
    const root = await tempRoot();
    await installZodVersion(root, "3.23.8");
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const messages = output();
    await ensureZodFloor({
      root,
      output: messages.sink,
      yes: true,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return 0;
      },
    });
    expect(calls).toEqual([{ command: "npm", args: ["install", ZOD_FLOOR_SPEC], cwd: root }]);
    expect(messages.logs.join("\n")).toContain(`Installed ${ZOD_FLOOR_SPEC}.`);
    expect(messages.errors).toEqual([]);
  });

  it("asks first in interactive runs; an accepted confirm performs the bump", async () => {
    const root = await tempRoot();
    await installZodVersion(root, "3.23.8");
    const questions: string[] = [];
    const calls: Array<{ args: string[] }> = [];
    await ensureZodFloor({
      root,
      output: output().sink,
      confirm: async (question, defaultYes) => {
        questions.push(question);
        expect(defaultYes).toBe(true);
        return true;
      },
      run: async (_command, args) => {
        calls.push({ args });
        return 0;
      },
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("zod@3.23.8");
    expect(questions[0]).toContain("3.25");
    expect(calls).toEqual([{ args: ["install", ZOD_FLOOR_SPEC] }]);
  });

  it("never mutates on a declined confirm — prints the exact command instead", async () => {
    const root = await tempRoot();
    await installZodVersion(root, "3.23.8");
    const calls: unknown[] = [];
    const messages = output();
    await ensureZodFloor({
      root,
      output: messages.sink,
      confirm: async () => false,
      run: async (...call) => {
        calls.push(call);
        return 0;
      },
    });
    expect(calls).toEqual([]);
    expect(messages.errors.join("\n")).toContain(`npm install ${ZOD_FLOOR_SPEC}`);
    expect(messages.errors.join("\n")).toContain("E-DEP-003");
  });

  it("never mutates non-interactively without --yes — prints the exact command", async () => {
    const root = await tempRoot();
    await installZodVersion(root, "3.23.8");
    const calls: unknown[] = [];
    const messages = output();
    await ensureZodFloor({
      root,
      output: messages.sink,
      run: async (...call) => {
        calls.push(call);
        return 0;
      },
    });
    expect(calls).toEqual([]);
    expect(messages.errors.join("\n")).toContain("zod@3.23.8");
    expect(messages.errors.join("\n")).toContain(`npm install ${ZOD_FLOOR_SPEC}`);
    expect(messages.errors.join("\n")).toContain("E-DEP-003");
  });

  it("is silent when the installed zod already meets the floor (3.25+, zod 4) or is absent", async () => {
    for (const version of ["3.25.0", "3.25.76", "4.1.8", null]) {
      const root = await tempRoot();
      if (version !== null) await installZodVersion(root, version);
      const calls: unknown[] = [];
      const messages = output();
      await ensureZodFloor({
        root,
        output: messages.sink,
        yes: true,
        run: async (...call) => {
          calls.push(call);
          return 0;
        },
      });
      expect(calls).toEqual([]);
      expect(messages.logs).toEqual([]);
      expect(messages.errors).toEqual([]);
    }
  });

  it("degrades to the exact manual command when the bump install fails, never throws", async () => {
    const root = await tempRoot();
    await installZodVersion(root, "3.24.1");
    const messages = output();
    await ensureZodFloor({
      root,
      output: messages.sink,
      yes: true,
      run: async () => null,
    });
    expect(messages.errors.join("\n")).toContain(`npm install ${ZOD_FLOOR_SPEC}`);
    expect(messages.errors.join("\n")).toContain("E-DEP-003");
  });
});

describe("ensureProviderDeps in a hoisted workspace", () => {
  it("sees the hoisted ai + provider and installs nothing", async () => {
    // The app resolves both through the workspace root's node_modules, exactly
    // as `ai` does at runtime. A root-only stat calls them missing and makes
    // `vendo init` shell a real install that rewrites the app's package.json.
    const workspace = await tempRoot();
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");
    await installModule(workspace, "ai");
    await installModule(workspace, "@ai-sdk/anthropic");
    const app = join(workspace, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "web" }));

    const calls: unknown[] = [];
    await ensureProviderDeps({
      root: app,
      credential: { rung: "vendo-cloud" },
      output: output().sink,
      run: async (...call) => {
        calls.push(call);
        return 0;
      },
    });

    expect(calls).toEqual([]);
  });
});

describe("ensureZodFloor in a hoisted workspace (checker round 1)", () => {
  /** pnpm workspace root hoisting zod@3.23.8, app nested with no
      node_modules or lockfile of its own — where most real hosts live. */
  async function hoistedWorkspaceApp(): Promise<{ workspace: string; app: string }> {
    const workspace = await tempRoot();
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");
    await installZodVersion(workspace, "3.23.8");
    const app = join(workspace, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "web", dependencies: { zod: "^3.23.8" } }));
    return { workspace, app };
  }

  it("detects the hoisted zod and prints the workspace's pnpm command, never npm", async () => {
    const { app } = await hoistedWorkspaceApp();
    const calls: unknown[] = [];
    const messages = output();
    await ensureZodFloor({
      root: app,
      output: messages.sink,
      run: async (...call) => {
        calls.push(call);
        return 0;
      },
    });
    expect(calls).toEqual([]);
    expect(messages.errors.join("\n")).toContain("zod@3.23.8");
    expect(messages.errors.join("\n")).toContain("pnpm add zod@^3.25.0");
    expect(messages.errors.join("\n")).not.toContain("npm install");
  });

  it("performs the --yes bump with the workspace's package manager from the app dir", async () => {
    const { app } = await hoistedWorkspaceApp();
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    await ensureZodFloor({
      root: app,
      output: output().sink,
      yes: true,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return 0;
      },
    });
    expect(calls).toEqual([{ command: "pnpm", args: ["add", ZOD_FLOOR_SPEC], cwd: app }]);
  });
});
