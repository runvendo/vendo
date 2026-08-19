import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aiBelowPeerFloor, defaultRunner, ensureGeneratedImports, ensureProviderDeps, ensureVendoPackage, ensureZodFloor, installCommandFor, installStderrTail, providerModuleFor, VENDO_PACKAGE_SPEC, zodBelowAiSdkFloor, ZOD_FLOOR_SPEC } from "../../src/cli/provider-deps.js";

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

async function installModule(root: string, name: string, version = "6.0.0"): Promise<void> {
  const dir = join(root, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }));
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

  /** An app nested under a workspace root that claims `globs`. */
  async function nestedUnderWorkspace(globs: string, appPath: string[], leafLockfile = true): Promise<string> {
    const ancestor = await tempRoot();
    await writeFile(join(ancestor, "pnpm-workspace.yaml"), `packages:\n${globs}overrides:\n  next: '>=16'\n`);
    const app = join(ancestor, ...appPath);
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: appPath.at(-1) }));
    if (leafLockfile) await writeFile(join(app, "pnpm-lock.yaml"), "");
    return app;
  }

  it("ignores an ANCESTOR workspace the host is not a member of", async () => {
    // A repo cloned into an unrelated monorepo (the corpus clones hosts into
    // this repo's own tree). pnpm walks up to the nearest pnpm-workspace.yaml,
    // so an unqualified `pnpm add` installs against the ancestor: its
    // overrides rewrite the host's pins under pnpm 11, and the add aborts on
    // the ancestor's store under pnpm 9.
    const app = await nestedUnderWorkspace("  - pkgs/*\n", [".repos", "skateshop"]);
    expect(await installCommandFor(app)).toEqual({ command: "pnpm", args: ["add", "--ignore-workspace"], cwd: app });
  });

  it("ignores it for a non-member that never installed, lockfile or not", async () => {
    // Membership is the workspace's answer, not the leaf's install state — a
    // freshly cloned host has no lockfile yet and is still not a member.
    const app = await nestedUnderWorkspace("  - pkgs/*\n", [".repos", "skateshop"], false);
    expect(await installCommandFor(app)).toEqual({ command: "pnpm", args: ["add", "--ignore-workspace"], cwd: app });
  });

  it("keeps a real member on the workspace even when it carries a stale lockfile", async () => {
    // A member can retain a copied or stale leaf pnpm-lock.yaml. Reading that
    // as "not a member" cut it loose from its own workspace and wrote the
    // repair into the leaf lockfile instead (Greptile P1, live reproduction).
    const app = await nestedUnderWorkspace("  - pkgs/*\n", ["pkgs", "web"]);
    expect(await installCommandFor(app)).toEqual({ command: "pnpm", args: ["add"], cwd: app });
  });

  it("honors a `!` exclusion — an excluded dir is not a member", async () => {
    const app = await nestedUnderWorkspace("  - pkgs/*\n  - '!pkgs/vendored'\n", ["pkgs", "vendored"]);
    expect(await installCommandFor(app)).toEqual({ command: "pnpm", args: ["add", "--ignore-workspace"], cwd: app });
  });

  it("treats a pattern it cannot model as a member — the conservative side", async () => {
    // Brace/extglob syntax is not modelled; guessing "not a member" would cut
    // a real member loose, so an unreadable pattern keeps today's behavior.
    const app = await nestedUnderWorkspace("  - '{apps,pkgs}/*'\n", ["apps", "web"]);
    expect(await installCommandFor(app)).toEqual({ command: "pnpm", args: ["add"], cwd: app });
  });

  it("matches deep globs the way pnpm does", async () => {
    const nested = await nestedUnderWorkspace("  - 'apps/**'\n", ["apps", "team", "web"]);
    expect((await installCommandFor(nested)).args).toEqual(["add"]);
    const tooDeep = await nestedUnderWorkspace("  - 'apps/*'\n", ["apps", "team", "web"]);
    expect((await installCommandFor(tooDeep)).args).toEqual(["add", "--ignore-workspace"]);
  });

  it("leaves a nested app that is its own workspace root alone", async () => {
    // Its own pnpm-workspace.yaml wins pnpm's upward walk, so the ancestor
    // never applies and --ignore-workspace would cut its own members loose.
    const ancestor = await tempRoot();
    await writeFile(join(ancestor, "pnpm-workspace.yaml"), "packages:\n  - pkgs/*\n");
    const app = join(ancestor, ".repos", "monorepo-host");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(app, "pnpm-lock.yaml"), "");
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

  /** The P1 #1213 left behind: since the selection law a bare provider key is
      `rung: "none"`, so asking the credential alone answered "no provider" for
      the very host whose route init had just given an `@ai-sdk/*` import — the
      generated app could not resolve its own import when it built. */
  it.each([
    ["openai", "@ai-sdk/openai@^3"],
    ["google", "@ai-sdk/google@^3"],
    ["anthropic", "@ai-sdk/anthropic@^3"],
  ] as const)("installs the provider it WROTE (%s) even with no runtime credential", async (wrote, spec) => {
    const root = await tempRoot();
    const calls: Array<{ args: string[] }> = [];
    await ensureProviderDeps({
      root,
      credential: { rung: "none" },
      wrote,
      output: output().sink,
      run: async (_command, args) => {
        calls.push({ args });
        return 0;
      },
    });
    expect(calls).toEqual([{ args: ["install", "ai@^6", spec] }]);
  });

  /** Two different answers, both needed: the gateway loads @ai-sdk/anthropic at
      runtime while the composition's own line imports @ai-sdk/openai. */
  it("installs BOTH when the credential and the written line disagree", async () => {
    const root = await tempRoot();
    const calls: Array<{ args: string[] }> = [];
    await ensureProviderDeps({
      root,
      credential: { rung: "vendo-cloud" },
      wrote: "openai",
      output: output().sink,
      run: async (_command, args) => {
        calls.push({ args });
        return 0;
      },
    });
    expect(calls).toEqual([{ args: ["install", "ai@^6", "@ai-sdk/anthropic@^3", "@ai-sdk/openai@^3"] }]);
  });

  it("names one provider once when both answers agree", async () => {
    const root = await tempRoot();
    const calls: Array<{ args: string[] }> = [];
    await ensureProviderDeps({
      root,
      credential: { rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" },
      wrote: "openai",
      output: output().sink,
      run: async (_command, args) => {
        calls.push({ args });
        return 0;
      },
    });
    expect(calls).toEqual([{ args: ["install", "ai@^6", "@ai-sdk/openai@^3"] }]);
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

/** #1153: `vendoai` is a thin alias that DEPENDS on @vendoai/vendo, so under
 *  pnpm's strict node_modules that package sits inside the alias's own nested
 *  resolution and the host cannot resolve the `@vendoai/vendo/*` imports every
 *  scaffold writes — the wired route fails to compile and 500s. */
describe("ensureGeneratedImports", () => {
  /** A tsconfig path alias is bare by every other test — no leading dot, slash
      or `node:` — so it reached the installer as if it were a package. `@/lib`
      has an EMPTY scope, which no npm name may have, and `pnpm add @/lib` wrote
      `"lib": "link:@/lib"` into the host's dependencies. A live proof found it
      there; doctor reports green over it. */
  it("never installs a tsconfig path alias, and still installs the real packages beside it", async () => {
    const root = await tempRoot();
    await installModule(root, "next");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "16.0.0" } }));
    const calls: Array<{ args: string[] }> = [];
    const messages = output();
    await ensureGeneratedImports({
      root,
      sources: [
        'import { vendo } from "@/lib/vendo";\n'
        + 'import { streamText } from "ai";\n'
        + 'import { anthropic } from "@ai-sdk/anthropic";\n'
        + 'import { createVendo } from "@vendoai/vendo/server";\n',
      ],
      output: messages.sink,
      run: async (_command, args) => {
        calls.push({ args });
        return 0;
      },
    });

    const installed = calls.flatMap((call) => call.args);
    // The alias never becomes a package specifier, under any spelling.
    expect(installed.some((arg) => arg.includes("@/lib"))).toBe(false);
    expect(installed).not.toContain("lib");
    // …and the real imports beside it are still declared.
    expect(installed).toContain("ai@^6");
    expect(installed).toContain("@ai-sdk/anthropic@^3");
    expect(installed).toContain(VENDO_PACKAGE_SPEC);
  });
});

describe("ensureVendoPackage", () => {
  it("adds the package the wiring imports when only the alias resolves", async () => {
    const root = await tempRoot();
    await installModule(root, "vendoai");
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const messages = output();
    await ensureVendoPackage({
      root,
      output: messages.sink,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return 0;
      },
    });
    expect(calls).toEqual([{ command: "pnpm", args: ["add", VENDO_PACKAGE_SPEC], cwd: root }]);
    expect(messages.logs.join("\n")).toContain(`Installed ${VENDO_PACKAGE_SPEC}.`);
    expect(messages.errors).toEqual([]);
  });

  it("stays quiet when the host can already resolve @vendoai/vendo (a hoisted or direct install)", async () => {
    const root = await tempRoot();
    await installModule(root, "vendoai");
    await installModule(root, "@vendoai/vendo");
    const calls: unknown[] = [];
    const messages = output();
    await ensureVendoPackage({ root, output: messages.sink, run: async (...call) => (calls.push(call), 0) });
    expect(calls).toEqual([]);
    expect(messages.logs).toEqual([]);
  });

  it("is not the repair for a host that has installed nothing yet", async () => {
    const root = await tempRoot();
    const calls: unknown[] = [];
    const messages = output();
    await ensureVendoPackage({ root, output: messages.sink, run: async (...call) => (calls.push(call), 0) });
    expect(calls).toEqual([]);
    expect(messages.logs).toEqual([]);
  });

  it("degrades to the exact manual command when the install fails, never throws", async () => {
    const root = await tempRoot();
    await installModule(root, "vendoai");
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    const messages = output();
    await ensureVendoPackage({ root, output: messages.sink, run: async () => null });
    expect(messages.errors.join("\n")).toContain(`pnpm add ${VENDO_PACKAGE_SPEC}`);
    expect(messages.errors.join("\n")).toContain("E-WIRE-011");
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

// FINDINGS F2-win (linkwarden baseline): on Windows the package managers are
// .cmd shims, so a shell-less spawn ENOENTs before the install starts — and
// with stdio ignored, the only trace was the generic "could not install"
// warning. The default runner must go through the platform shell, keep
// caret-bearing specs like ai@^6 intact, and surface the child's stderr.

describe("defaultRunner", () => {
  it("runs a real child process and resolves its exit code on every platform", async () => {
    const root = await tempRoot();
    expect(await defaultRunner("node", ["-e", "process.exit(0)"], root)).toBe(0);
  });

  it("captures the failing child's stderr so the warning can say why", async () => {
    const root = await tempRoot();
    const code = await defaultRunner(
      "node",
      ["-e", "process.stderr.write('EACCES: permission denied', () => process.exit(1))"],
      root,
    );
    expect(code).toBe(1);
    expect(installStderrTail()).toContain("EACCES: permission denied");
  });

  it("carries a caret-bearing spec through the platform shell intact", async () => {
    // cmd.exe treats ^ as an escape character outside double quotes, so an
    // unquoted ai@^6 arrives as ai@6 — the wrong install, silently.
    const root = await tempRoot();
    await defaultRunner(
      "node",
      ["-e", "process.stderr.write(process.argv[1], () => process.exit(1))", "ai@^6"],
      root,
    );
    expect(installStderrTail()).toBe("ai@^6");
  });

  it("keeps only the tail of a long stderr stream", async () => {
    const root = await tempRoot();
    await defaultRunner(
      "node",
      ["-e", "process.stderr.write('x'.repeat(5000) + 'THE-END', () => process.exit(1))"],
      root,
    );
    const tail = installStderrTail();
    expect(tail.length).toBeLessThanOrEqual(2000);
    expect(tail).toContain("THE-END");
  });
});

// A host whose tsconfig maps `@/*` gets `@/lib/vendo` in its generated files.
// That specifier's scope segment is empty, so it is no npm package at all —
// installing it wrote `"lib": "link:@/lib"` into the manifest, and the host's
// next `npm install` died on EUNSUPPORTEDPROTOCOL.

describe("ensureGeneratedImports", () => {
  it("installs the packages a generated file imports, never its path aliases", async () => {
    const root = await tempRoot();
    await installModule(root, "next");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const calls: Array<{ command: string; args: string[] }> = [];
    const messages = output();
    await ensureGeneratedImports({
      root,
      sources: [`import { vendo } from "@/lib/vendo";\nimport { anthropic } from "@ai-sdk/anthropic";\n`],
      output: messages.sink,
      run: async (command, args) => (calls.push({ command, args }), 0),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(" ")).toContain("@ai-sdk/anthropic");
    expect(calls[0]!.args.join(" ")).not.toContain("@/lib");
  });
});

describe("install-failure warnings", () => {
  it("a custom runner's failure never carries a stale default-runner tail", async () => {
    // Seed the module tail with a real default-runner failure, then fail via
    // an injected runner: the tail belongs to the default runner's run only.
    const root = await tempRoot();
    await defaultRunner("node", ["-e", "process.stderr.write('stale tail', () => process.exit(1))"], root);
    const messages = output();
    await ensureProviderDeps({
      root,
      credential: { rung: "vendo-cloud" },
      output: messages.sink,
      run: async () => null,
    });
    expect(messages.errors.join("\n")).toContain("E-DEP-001");
    expect(messages.errors.join("\n")).not.toContain("install said");
    expect(messages.errors.join("\n")).not.toContain("stale tail");
  });
});

// FINDINGS F3 (linkwarden baseline): a resolvable pre-v6 `ai` — usually some
// other package's hoisted copy — satisfied the presence check, suppressed the
// ai@^6 install, and every turn then 500d at runtime on the peer mismatch.
// A below-floor major is a missing install, not a satisfied one.

describe("aiBelowPeerFloor", () => {
  it("draws the line at the v6 peer contract", () => {
    expect(aiBelowPeerFloor("5.0.59")).toBe(true);
    expect(aiBelowPeerFloor("4.3.19")).toBe(true);
    expect(aiBelowPeerFloor("6.0.0")).toBe(false);
    expect(aiBelowPeerFloor("6.0.230")).toBe(false);
    // v7 is inside the peer contract, so it is not the floor's story either.
    expect(aiBelowPeerFloor("7.0.2")).toBe(false);
    // An unparseable version is not evidence of an old ai.
    expect(aiBelowPeerFloor("not-a-version")).toBe(false);
  });
});

describe("ensureProviderDeps with a pre-v6 ai installed", () => {
  it("treats a resolvable ai@5 as missing and installs the ai@^6 floor", async () => {
    const root = await tempRoot();
    await installModule(root, "ai", "5.0.59");
    await installModule(root, "@ai-sdk/anthropic");
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    await ensureProviderDeps({
      root,
      credential: { rung: "vendo-cloud" },
      output: output().sink,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return 0;
      },
    });
    expect(calls).toEqual([{ command: "npm", args: ["install", "ai@^6"], cwd: root }]);
  });

  it("installs over a workspace root's hoisted ai@5 so the app resolves its own v6", async () => {
    const workspace = await tempRoot();
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");
    await installModule(workspace, "ai", "5.0.59");
    await installModule(workspace, "@ai-sdk/anthropic");
    const app = join(workspace, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "web" }));
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    await ensureProviderDeps({
      root: app,
      credential: { rung: "vendo-cloud" },
      output: output().sink,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return 0;
      },
    });
    expect(calls).toEqual([{ command: "pnpm", args: ["add", "ai@^6"], cwd: app }]);
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

  it("scopes the bump to a host nested inside an unrelated workspace", async () => {
    // The repair that never landed: under the corpus's nesting the bump ran
    // against the ancestor workspace, so the host's zod stayed below the floor.
    const ancestor = await tempRoot();
    await writeFile(join(ancestor, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const app = join(ancestor, ".repos", "skateshop");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "skateshop" }));
    await writeFile(join(app, "pnpm-lock.yaml"), "");
    await installZodVersion(app, "3.23.8");

    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const messages = output();
    await ensureZodFloor({
      root: app,
      output: messages.sink,
      yes: true,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return 0;
      },
    });
    expect(calls).toEqual([{ command: "pnpm", args: ["add", "--ignore-workspace", ZOD_FLOOR_SPEC], cwd: app }]);
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
