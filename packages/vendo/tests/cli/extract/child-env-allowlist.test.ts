import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCliHarness } from "../../../src/cli/extract/claude-cli-harness.js";
import { claudeHarness } from "../../../src/cli/extract/claude-harness.js";
import { codexCliHarness } from "../../../src/cli/extract/codex-cli-harness.js";
import type { ExtractionHarness } from "../../../src/cli/extract/harness.js";
import { npxEngineHarness } from "../../../src/cli/extract/npx-engine-harness.js";
import { EXTRACTION_DOTENV_ALLOWLIST, readEnvFiles } from "../../../src/cli/sync-flow.js";

/**
 * The extraction boundary: an untrusted repo dotenv reaches the coding-agent
 * children (`npm`, `claude`, `codex`) sync spawns, so a cloned repo must not be
 * able to inject code into them (a registry/NODE_OPTIONS the child obeys) or
 * redirect their credentials (a Cloud endpoint the key is sent to). These test
 * the SEAM with no stub between the producer and the consumer: the REAL
 * `readEnvFiles` reads a real `.env`, feeds the REAL harness, and only the leaf
 * child spawn is captured — the exact path `runSyncFlow` walks.
 */

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function hostWithDotenv(dotenv: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-child-env-"));
  dirs.push(root);
  await writeFile(join(root, ".env"), dotenv, "utf8");
  return root;
}

/** stdout each harness's parser accepts, so run() reaches the child spawn. */
const STDOUT = "```json\n" + JSON.stringify({ tools: [], narrative: "" }) + "\n```";

/** The three real spawning rungs, built for real with only the leaf child
 *  captured. Codex has no `-p` stdout, so its own exec seam returns bare text. */
const rungs: ReadonlyArray<{
  name: string;
  harness: (capture: (env: NodeJS.ProcessEnv) => void) => ExtractionHarness;
}> = [
  {
    name: "the PATH `claude` rung",
    harness: (capture) => claudeCliHarness({
      probeBinary: async () => true,
      probeLogin: async () => false,
      exec: async (_args, options) => { capture(options.env); return { stdout: STDOUT, stderr: "", code: 0 }; },
    }),
  },
  {
    name: "the npx-fetched engine rung",
    harness: (capture) => npxEngineHarness({
      exec: async (_args, options) => { capture(options.env); return { stdout: STDOUT, stderr: "", code: 0 }; },
    }),
  },
  {
    name: "the `codex` rung",
    harness: (capture) => codexCliHarness({
      probeBinary: async () => true,
      probeLogin: async () => true,
      exec: async (_args, options) => { capture(options.env); return { stdout: "done", stderr: "", code: 0 }; },
    }),
  },
];

async function childEnv(
  harnessFor: (capture: (env: NodeJS.ProcessEnv) => void) => ExtractionHarness,
  root: string,
): Promise<NodeJS.ProcessEnv> {
  let captured: NodeJS.ProcessEnv | undefined;
  // The real extraction path: readEnvFiles under its allowlist, then the rung
  // forwards that env to the child — no stub between producer and consumer.
  const env = await readEnvFiles(root, process.env, EXTRACTION_DOTENV_ALLOWLIST);
  await harnessFor((seen) => { captured ??= seen; }).run({ root, env, instructions: "go" });
  expect(captured).toBeDefined();
  return captured!;
}

describe("readEnvFiles applies the extraction allowlist only when asked", () => {
  it("under the allowlist, a repo dotenv contributes credentials but no injection/redirect var", async () => {
    const root = await hostWithDotenv(
      "VENDO_API_KEY=vnd_x\nNODE_OPTIONS=--require ./repo-evil.js\n"
      + "npm_config_registry=https://registry.repo-evil.example\nVENDO_CLOUD_URL=https://evil-cloud.example\n",
    );
    expect(await readEnvFiles(root, {}, EXTRACTION_DOTENV_ALLOWLIST)).toEqual({ VENDO_API_KEY: "vnd_x" });
  });

  it("the general reader (no allowlist) still passes arbitrary config keys through — doctor reads it", async () => {
    const root = await hostWithDotenv("VENDO_STORE_ENCRYPTION_KEY=k\nSOME_HOST_CONFIG=v\n");
    const env = await readEnvFiles(root, {});
    expect(env["VENDO_STORE_ENCRYPTION_KEY"]).toBe("k");
    expect(env["SOME_HOST_CONFIG"]).toBe("v");
  });
});

describe("an untrusted repo dotenv cannot inject code into the extraction children", () => {
  // Each carries a distinctive marker: the assertion is that the repo's own
  // value never survives into the child env, regardless of any ambient value.
  const injections = [
    { key: "NODE_OPTIONS", value: "--require ./repo-evil.js", marker: "repo-evil" },
    { key: "npm_config_registry", value: "https://registry.repo-evil.example", marker: "repo-evil" },
  ];

  for (const { name, harness } of rungs) {
    for (const { key, value, marker } of injections) {
      it(`${name}: a repo dotenv ${key} never reaches the child env`, async () => {
        // Blank the ambient value so the repo file's value is the only source
        // that could flow through (the blank-process fallback in readEnvFiles).
        vi.stubEnv(key, "");
        const root = await hostWithDotenv(`${key}=${value}\n`);
        const env = await childEnv(harness, root);
        expect(String(env[key] ?? "")).not.toContain(marker);
      });
    }
  }
});

describe("an untrusted repo dotenv cannot redirect the Cloud key to its own endpoint", () => {
  // Only the two Claude-Code-shaped rungs compose gateway fuel; codex never
  // reads VENDO_CLOUD_URL.
  const gatewayRungs = rungs.slice(0, 2);
  for (const { name, harness } of gatewayRungs) {
    it(`${name}: a repo VENDO_CLOUD_URL cannot capture ANTHROPIC_AUTH_TOKEN`, async () => {
      for (const ambient of [
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
        "VENDO_API_KEY", "VENDO_CLOUD_URL", "VENDO_DEV_CREDENTIAL",
      ]) vi.stubEnv(ambient, "");
      const root = await hostWithDotenv("VENDO_API_KEY=vnd_x\nVENDO_CLOUD_URL=https://evil-cloud.example\n");
      const env = await childEnv(harness, root);
      // The child still runs on the Cloud key — it just runs against the real
      // gateway, never the endpoint the repo tried to name.
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("vnd_x");
      expect(String(env.ANTHROPIC_BASE_URL ?? "")).not.toContain("evil-cloud");
    });
  }
});

describe("the developer's own SHELL still reaches the child (provenance, not variable name)", () => {
  it("a shell NODE_OPTIONS is the developer's choice and passes through", async () => {
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=8192");
    const root = await hostWithDotenv("");
    const env = await childEnv(rungs[0]!.harness, root);
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
  });
});

describe("a repo-root .npmrc cannot redirect the npx rung's registry (VEGA-INFO-00078, file half)", () => {
  async function repoWithNpmrc(npmrc: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vendo-npmrc-"));
    dirs.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "victim", version: "1.0.0" }), "utf8");
    await writeFile(join(root, ".npmrc"), npmrc, "utf8");
    return root;
  }

  // The npx rung's REAL child (cwd + env), fed to real `npm config get` in the
  // repo — the assertion is npm's own effective config, not a mock, so it proves
  // the pin actually outranks the project .npmrc npm reads from cwd.
  async function effectiveRegistry(root: string): Promise<{ registry: string; scoped: string }> {
    let seen: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
    const harness = npxEngineHarness({
      exec: async (_args, options) => { seen = options; return { stdout: STDOUT, stderr: "", code: 0 }; },
    });
    await harness.run({
      root,
      env: await readEnvFiles(root, process.env, EXTRACTION_DOTENV_ALLOWLIST),
      instructions: "go",
    });
    const get = (key: string): string =>
      execFileSync("npm", ["config", "get", key], { cwd: seen!.cwd, env: seen!.env, encoding: "utf8" }).trim();
    return { registry: get("registry"), scoped: get("@anthropic-ai:registry") };
  }

  it("overrides a bogus default AND scoped registry the repo's .npmrc set", async () => {
    vi.stubEnv("npm_config_registry", ""); // worst case: the developer set no registry of their own
    const root = await repoWithNpmrc("registry=http://evil.example/\n@anthropic-ai:registry=http://evil.scope.example/\n");
    const { registry, scoped } = await effectiveRegistry(root);
    expect(registry).toBe("https://registry.npmjs.org/");
    expect(scoped).not.toContain("evil");
  });

  it("ignores an ambient/shell npm_config_registry too — the child always fetches from the public default", async () => {
    // F5 (VEGA-INFO-00078): when Vendo is itself launched via `npx`/`npm exec`
    // from inside the scanned checkout, npm exports THAT checkout's `.npmrc`
    // `registry` into Vendo's own process env as `npm_config_registry` — so an
    // ambient/shell value is repo-influenced and indistinguishable from a
    // poisoned one. The rung therefore drops all ambient trust and pins the
    // child to the public default, whatever the shell or the repo set. (A
    // corporate mirror configured only in ~/.npmrc is not honored on this
    // last-resort rung — accepted; the PATH/local-install rungs still are.)
    vi.stubEnv("npm_config_registry", "https://mirror.corp.example/");
    const root = await repoWithNpmrc("registry=http://evil.example/\n");
    expect((await effectiveRegistry(root)).registry).toBe("https://registry.npmjs.org/");
  });
});

describe("the Agent SDK availability probe never executes host-resolved module code", () => {
  it("answers 'is it here' by resolving the specifier, not importing it (an import would throw)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-sdk-probe-"));
    dirs.push(root);
    // A fake SDK resolvable from the host root whose module body THROWS the
    // instant it is imported. Resolving it is fine; importing it is not — so a
    // probe that resolves reports available, and one that imports catches the
    // throw and reports unavailable. The verdict, not a side effect, is the tell
    // (vite's dynamic-import handling makes a side-effect marker unreliable).
    const pkgDir = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0", main: "index.js" }),
      "utf8",
    );
    await writeFile(
      join(pkgDir, "index.js"),
      `throw new Error("the availability probe must not import the SDK");\n`,
      "utf8",
    );

    // Production path: no loadSdk seam, so availability uses require.resolve.
    const label = await claudeHarness({ probeLogin: async () => false })
      .availability({ root, env: { ANTHROPIC_API_KEY: "sk" } });

    expect(label).toBe("your ANTHROPIC_API_KEY"); // resolvable → available, without importing
  });

  it("checks the credential first — with none, it never even reaches the SDK loader", async () => {
    // The loader throws if called; credential-first means it is not called when
    // no credential is present, so availability returns null cleanly.
    const harness = claudeHarness({
      loadSdk: async () => { throw new Error("availability must not load the SDK without a credential"); },
      probeLogin: async () => false,
    });
    expect(await harness.availability({ root: "/x", env: {} })).toBeNull();
  });
});
