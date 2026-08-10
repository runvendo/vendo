import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeDevCredential, resolveDevCredential } from "../../src/dev-creds/resolve.js";
import { claudeCliHarness } from "../../src/cli/extract/claude-cli-harness.js";
import type { ExtractionHarness } from "../../src/cli/extract/harness.js";
import { npxEngineHarness } from "../../src/cli/extract/npx-engine-harness.js";
import type { Output } from "../../src/cli/shared.js";
import { readEnvFiles, rendererFlowOptions, runSyncFlow, type SyncFlowOptions, type SyncFlowResult } from "../../src/cli/sync-flow.js";

/**
 * The ONE flow `vendo init` (mode "full") and `vendo sync` (mode "incremental")
 * both run: one env reader that sees BOTH dotenv files, one consent question,
 * one theme path (create when missing, reconcile when present).
 */

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function host(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-sync-flow-"));
  dirs.push(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(root, name), source, "utf8");
  }
  return root;
}

function captureOutput() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) }, logs, errors };
}

const REPORT = {
  tools: { added: [], removed: [], changed: [] },
  breaking: [],
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 0, registered: 0 },
  components: { captured: [], drifted: [] },
  toolSchemas: { total: 0, inputs: { known: 0, unknown: [] }, outputs: { known: 0, unknown: [] } },
  warnings: [],
};

const scan = (async () => REPORT) as never;

/** A judged catalog whose one tool is unchanged: incremental has nothing to do,
 *  full re-judges it. The difference IS the mode, read through the real pass. */
const JUDGED_CATALOG = {
  "tools.json": `${JSON.stringify({
    format: "vendo/tools@3",
    tools: [{
      name: "host_a",
      description: "Use this to call host_a.",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/a", argsIn: "query" },
    }],
  })}\n`,
  "judgments.json": `${JSON.stringify({
    format: "vendo/judgments@1",
    tools: {
      host_a: {
        binding: "GET /api/a",
        fields: { description: "Reads the counter." },
        evidence: "export async function GET() {",
      },
    },
  })}\n`,
};

/** One never-judged tool, so incremental mode has real work and the run
 *  reaches the engine rather than the up-to-date shortcut. */
const UNJUDGED_TOOLS = `${JSON.stringify({
  format: "vendo/tools@3",
  tools: [{
    name: "host_a",
    description: "Use this to call host_a.",
    inputSchema: { type: "object", properties: {} },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/a", argsIn: "query" },
  }],
})}\n`;

const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

/** The flow as `vendo sync` runs it: incremental, non-interactive. */
function flow(options: Partial<SyncFlowOptions> & { root: string; output: Output }): Promise<SyncFlowResult> {
  return runSyncFlow({ mode: "incremental", interactive: false, yes: false, sync: scan, ...options });
}

/** A harness that fails loudly if the judgment pass so much as probes it. */
const forbidden = {
  id: "never",
  availability: async () => { throw new Error("the judgment pass must not run here"); },
  run: async () => { throw new Error("the judgment pass must not run here"); },
};

/** An available engine, so a run reaches the consent question instead of
 *  stopping at the availability check. */
const engine = {
  id: "scripted",
  availability: async () => "a scripted engine",
  run: async () => { throw new Error("declined consent must never reach the engine"); },
};

describe("runSyncFlow", () => {
  it("judges the WHOLE catalog in full mode and only what moved in incremental", async () => {
    const invocations: number[] = [];
    for (const mode of ["incremental", "full"] as const) {
      const root = await host(JUDGED_CATALOG);
      // The `.vendo` copies are what the pass reads.
      for (const [name, source] of Object.entries(JUDGED_CATALOG)) {
        await writeFile(join(root, ".vendo", name), source, "utf8");
      }
      let calls = 0;
      const { output } = captureOutput();
      await runSyncFlow({
        root, output, mode, interactive: false, yes: true, ai: true, sync: scan,
        judge: {
          harness: {
            id: "scripted",
            availability: async () => "a scripted engine",
            run: async () => {
              calls += 1;
              return "```json\n" + JSON.stringify({ tools: [], narrative: "" }) + "\n```";
            },
          },
        },
      });
      invocations.push(calls);
    }
    expect(invocations).toEqual([0, 1]);
  });

  it("asks for consent exactly ONCE, with the same question in both modes", async () => {
    const asked: string[] = [];
    for (const mode of ["full", "incremental"] as const) {
      const { output } = captureOutput();
      await runSyncFlow({
        root: await host(), output, mode, interactive: true, yes: false, sync: scan,
        confirm: async (question: string) => { asked.push(question); return false; },
        judge: { harnesses: [engine] },
      });
    }
    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(asked[1]);
  });

  it("creates .vendo/theme.json when absent and reconciles it when present", async () => {
    const root = await host();
    const { output } = captureOutput();
    const created = await runSyncFlow({
      root, output, mode: "full", interactive: false, yes: true, ai: false, sync: scan,
    });
    expect(created.theme).toBeNull();
    await expect(readFile(join(root, ".vendo", "theme.json"), "utf8")).resolves.toContain("colors");

    const reconciled = await runSyncFlow({
      root, output, mode: "incremental", interactive: false, yes: true, ai: false, sync: scan,
    });
    expect(reconciled.theme).not.toBeNull();
  });
});

/**
 * The two phases that can hold a terminal for minutes — extraction and the
 * judgment pass — get the caller's spinner when it has one. Full mode's
 * "Reading your product (…)…" line is the SAME string either way: the label
 * when a renderer is attached, the printed line when there is none.
 */
describe("the slow phases spin when the caller supplies one", () => {
  const scripted = {
    id: "scripted",
    availability: async () => "a scripted engine",
    run: async () => "```json\n" + JSON.stringify({ tools: [], narrative: "" }) + "\n```",
  };

  // Cause one of #1163: init handed the flow its questions and NOT its spinner,
  // so `withSpin` was a no-op for every install. Both commands now build these
  // options the same way, which is the only thing that keeps them in step.
  it("a renderer contributes its spinner, not just its questions", () => {
    const pretty = {
      confirm: async () => true,
      select: async () => "",
      spin: () => {},
      stopSpin: () => {},
    };
    const wired = rendererFlowOptions(pretty);
    expect(wired.spinner).toBeDefined();
    expect(wired.confirm).toBe(pretty.confirm);
    expect(wired.choose).toBe(pretty.select);
    // No renderer → the flow keeps today's plain behaviour, nothing added.
    expect(rendererFlowOptions(null)).toEqual({});
  });

  it("labels extraction and the judgment pass in both modes", async () => {
    const seen: Record<string, { labels: string[]; stops: number; logs: string[] }> = {};
    for (const mode of ["full", "incremental"] as const) {
      const labels: string[] = [];
      let stops = 0;
      const { output, logs } = captureOutput();
      await runSyncFlow({
        root: await host(), output, mode, interactive: true, yes: false, sync: scan,
        fetchImpl: offline,
        confirm: async () => true,
        judge: { harnesses: [scripted] },
        spinner: { spin: (label) => labels.push(label), stopSpin: () => { stops += 1; } },
      });
      seen[mode] = { labels, stops, logs };
    }
    // THREE phases in full mode, and the third is the one that matters: the
    // judgment pass answers in milliseconds when nothing changed, so its
    // `finally` used to stop the spinner right before the prose stages — the
    // two model calls that own minutes of the run — leaving the longest stretch
    // of an install as a dead screen (#1163).
    expect(seen.full!.labels).toEqual([
      "Re-reading your product…",
      "Reading your product (a scripted engine)…",
      "Reading your product (a scripted engine)…",
    ]);
    expect(seen.full!.stops).toBe(3);
    // The line became the label; it is not ALSO printed.
    expect(seen.full!.logs.join("\n")).not.toContain("Reading your product");
    expect(seen.incremental!.labels).toEqual([
      "Re-reading your product…",
      "Judging what moved… (a scripted engine)",
    ]);
  });

  it("without a spinner full mode prints exactly the line it prints today", async () => {
    const { output, logs } = captureOutput();
    await runSyncFlow({
      root: await host(), output, mode: "full", interactive: true, yes: false, sync: scan,
      fetchImpl: offline,
      confirm: async () => true,
      judge: { harnesses: [scripted] },
    });
    expect(logs).toContain("\nReading your product (a scripted engine)…");
  });
});

describe("the AI flag matrix (one rule, both modes)", () => {
  it("interactive with no flag ASKS, every run — nothing is persisted", async () => {
    const dir = await host();
    for (const pass of [1, 2]) {
      const asked: string[] = [];
      const messages = captureOutput();
      await flow({
        root: dir,
        output: messages.output,
        fetchImpl: offline,
        interactive: true,
        judge: { harnesses: [engine], confirm: async (question: string) => { asked.push(question); return false; } },
      });
      expect(asked.length, `run ${pass} asked`).toBe(1);
      expect(asked[0]).toContain("read this codebase to draft tool descriptions");
    }
  });

  it("non-interactive with no flag never prompts and never runs the pass", async () => {
    const messages = captureOutput();
    await flow({
      root: await host(),
      output: messages.output,
      fetchImpl: offline,
      judge: { harnesses: [forbidden], confirm: async () => { throw new Error("prompted in a non-interactive run"); } },
    });
    expect(messages.logs.join("\n")).toContain("judgment: skipped — this run cannot ask");
  });

  it("--yes cannot ask, whatever the terminal says", async () => {
    const messages = captureOutput();
    await flow({
      root: await host(),
      output: messages.output,
      fetchImpl: offline,
      interactive: true,
      yes: true,
      judge: { harnesses: [forbidden], confirm: async () => { throw new Error("prompted"); } },
    });
    expect(messages.logs.join("\n")).toContain("judgment: skipped — this run cannot ask");
  });

  it("--no-ai forces the pass off in an interactive run too", async () => {
    const messages = captureOutput();
    await flow({
      root: await host(),
      output: messages.output,
      fetchImpl: offline,
      ai: false,
      interactive: true,
      judge: { harnesses: [forbidden], confirm: async () => { throw new Error("prompted"); } },
    });
    expect(messages.logs.join("\n")).not.toContain("judgment");
  });
});

describe("a harness-owned credential (Claude Code OAuth / auth token / custom endpoint)", () => {
  /** The Claude Code rungs run on any of ANTHROPIC_AUTH_TOKEN,
   *  CLAUDE_CODE_OAUTH_TOKEN or a custom ANTHROPIC_BASE_URL — none of which is
   *  a product-turn API key. Only `availability()` knows that, so only
   *  `availability()` may decide whether this run has an engine. */
  const oauthEngine: ExtractionHarness = {
    id: "oauth-only",
    availability: async ({ env }) =>
      (env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "") === "" ? null : "your CLAUDE_CODE_OAUTH_TOKEN",
    run: async () => "```json\n" + JSON.stringify({ tools: [], narrative: "" }) + "\n```",
  };

  /** A host holding ONLY a harness-owned credential: no API key on any rung. */
  async function oauthHost(): Promise<string> {
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "VENDO_API_KEY", "VENDO_DEV_CREDENTIAL"]) {
      vi.stubEnv(name, "");
    }
    const root = await host({ ".env": "CLAUDE_CODE_OAUTH_TOKEN=oauth-tok\n" });
    await writeFile(join(root, ".vendo", "tools.json"), UNJUDGED_TOOLS, "utf8");
    return root;
  }

  it("`sync --ai` on an incremental run reaches the engine, same as init and an interactive sync", async () => {
    const messages = captureOutput();
    const result = await flow({
      root: await oauthHost(),
      output: messages.output,
      fetchImpl: offline,
      ai: true,
      judge: { harnesses: [oauthEngine] },
    });
    expect(messages.logs.join("\n")).not.toContain("structural-only");
    expect(result.judged.ran).toBe(true);
  });

  it("leaves the runtime model ladder alone: the same env still has NO product-turn credential", async () => {
    // doctor, doctor-live and dev-creds/model.ts all read this one resolver,
    // and an interactive-only OAuth token cannot serve a product turn. Widening
    // it would be a worse bug than the one above.
    const root = await oauthHost();
    const env = await readEnvFiles(root);
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-tok");
    expect(await resolveDevCredential({ env })).toEqual({ rung: "none" });
    expect(describeDevCredential(await resolveDevCredential({ env }))).toBe("no model credential found");
  });
});

describe("the coding-agent endpoint is the developer's to choose, never the project's", () => {
  const REPO_ENDPOINT = "https://repo-chose-this.example.com";
  const SHELL_ENDPOINT = "https://anthropic.corp.example.com";

  /** stdout the judgment pass accepts, so the run reaches the child spawn
   *  whose env is what these tests are actually about. */
  const JUDGED = "```json\n" + JSON.stringify({ tools: [], narrative: "" }) + "\n```";

  /** Both Claude rungs, built for real, with only the child spawn stubbed:
   *  the env under test is the one the REAL harness hands the REAL spawn,
   *  produced by the REAL dotenv reader — no stub on either side of the seam. */
  const rungs: ReadonlyArray<{
    name: string;
    harness: (capture: (env: NodeJS.ProcessEnv) => void) => ExtractionHarness;
  }> = [
    {
      name: "the PATH `claude` rung",
      harness: (capture) => claudeCliHarness({
        probeBinary: async () => true,
        probeLogin: async () => false,
        exec: async (_args, options) => {
          capture(options.env);
          return { stdout: JUDGED, stderr: "", code: 0 };
        },
      }),
    },
    {
      name: "the npx-fetched engine rung",
      harness: (capture) => npxEngineHarness({
        exec: async (_args, options) => {
          capture(options.env);
          return { stdout: JUDGED, stderr: "", code: 0 };
        },
      }),
    },
  ];

  /** A host with a Cloud key and one never-judged tool, so an incremental
   *  `--ai` run has real work and actually spawns the child. No credential of
   *  the developer's own — the exposed case. */
  async function keyedHost(dotenv: string): Promise<string> {
    for (const name of [
      "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
      "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
      "VENDO_API_KEY", "VENDO_CLOUD_URL", "VENDO_DEV_CREDENTIAL",
    ]) {
      vi.stubEnv(name, "");
    }
    const root = await host({ ".env": `VENDO_API_KEY=vnd_x\n${dotenv}` });
    await writeFile(join(root, ".vendo", "tools.json"), UNJUDGED_TOOLS, "utf8");
    return root;
  }

  async function spawnEnvFor(
    rung: (capture: (env: NodeJS.ProcessEnv) => void) => ExtractionHarness,
    root: string,
  ): Promise<NodeJS.ProcessEnv | undefined> {
    let captured: NodeJS.ProcessEnv | undefined;
    const messages = captureOutput();
    await flow({
      root,
      output: messages.output,
      fetchImpl: offline,
      ai: true,
      judge: { harnesses: [rung((env) => { captured ??= env; })] },
    });
    return captured;
  }

  for (const { name, harness } of rungs) {
    it(`${name}: a project dotenv naming a base URL never reaches the child process`, async () => {
      const root = await keyedHost(`ANTHROPIC_BASE_URL=${REPO_ENDPOINT}\n`);
      const env = await spawnEnvFor(harness, root);
      // The child really ran — it just ran on Vendo Cloud's gateway (the Cloud
      // key IS the developer's own credential here), never on the endpoint the
      // repo tried to pick.
      expect(env).toBeDefined();
      expect(env?.ANTHROPIC_BASE_URL).not.toContain("repo-chose-this");
      expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("vnd_x");
    });

    it(`${name}: the developer's own SHELL base URL still reaches the child process`, async () => {
      const root = await keyedHost("");
      vi.stubEnv("ANTHROPIC_BASE_URL", SHELL_ENDPOINT);
      const env = await spawnEnvFor(harness, root);
      expect(env?.ANTHROPIC_BASE_URL).toBe(SHELL_ENDPOINT);
      // Own credential wins: no gateway fuel overlaid onto the dev's endpoint.
      expect(env?.ANTHROPIC_AUTH_TOKEN).toBeFalsy();
    });
  }

  it("readEnvFiles drops a dotenv base URL and keeps the shell's — provenance, not variable name", async () => {
    const root = await host({ ".env": `ANTHROPIC_BASE_URL=${REPO_ENDPOINT}\nVENDO_API_KEY=vnd_x\n` });
    expect(await readEnvFiles(root, {})).toEqual({ VENDO_API_KEY: "vnd_x" });
    // A blank shell value must NOT fall back to the file one either.
    expect((await readEnvFiles(root, { ANTHROPIC_BASE_URL: "" }))["ANTHROPIC_BASE_URL"]).toBe("");
    expect((await readEnvFiles(root, { ANTHROPIC_BASE_URL: SHELL_ENDPOINT }))["ANTHROPIC_BASE_URL"])
      .toBe(SHELL_ENDPOINT);
  });
});

describe("the theme re-scan (decision 3)", () => {
  /** A host whose CSS declares a brand, plus the theme.json + merge base a
      prior `vendo init` would have written from exactly that CSS. */
  async function themedHost(accent: string): Promise<string> {
    const dir = await host();
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "layout.tsx"), 'import "./globals.css";\nexport default () => null;\n', "utf8");
    await writeFile(join(dir, "app", "globals.css"),
      `:root { --primary: ${accent}; --background: #ffffff; --radius: 8px; }\n`, "utf8");
    return dir;
  }

  const themeJson = (accent: string, extra: Record<string, unknown> = {}) => ({
    colors: {
      background: "#ffffff", surface: "#f8fafc", text: "#0f172a", muted: "#64748b",
      accent, accentText: "#ffffff", danger: "#dc2626", border: "#e2e8f0",
    },
    typography: { fontFamily: "system-ui, sans-serif", headingFamily: "system-ui, sans-serif", baseSize: "16px" },
    radius: { small: "4px", medium: "8px", large: "12px" },
    density: "comfortable",
    motion: "full",
    ...extra,
  });

  const writeTheme = (dir: string, theme: unknown) =>
    writeFile(join(dir, ".vendo", "theme.json"), `${JSON.stringify(theme, null, 2)}\n`, "utf8");
  const writeBase = (dir: string, slots: Record<string, string>) =>
    writeFile(join(dir, ".vendo", "theme.extracted.json"),
      `${JSON.stringify({ format: "vendo/theme-extracted@1", at: "2026-01-01T00:00:00.000Z", slots }, null, 2)}\n`, "utf8");

  const read = async (dir: string) =>
    JSON.parse(await readFile(join(dir, ".vendo", "theme.json"), "utf8")) as ReturnType<typeof themeJson>;

  it("takes a rebrand: a machine-extracted slot follows the host's new CSS", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#7c3bed"));
    await writeBase(dir, { accent: "#7c3bed", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    expect((await read(dir)).colors.accent).toBe("#0f766e");
    expect(messages.logs.join("\n")).toContain("theme: 1 slot re-read from your app (accent)");
  });

  it("leaves a HAND-EDITED slot alone and reports it as pinned", async () => {
    const dir = await themedHost("#0f766e");
    // theme.json says #ff0000, the base says the machine last read #7c3bed:
    // the value on disk is a human's, so the new #0f766e must not land.
    await writeTheme(dir, themeJson("#ff0000"));
    await writeBase(dir, { accent: "#7c3bed", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    expect((await read(dir)).colors.accent).toBe("#ff0000");
    const logs = messages.logs.join("\n");
    expect(logs).toContain("1 pinned by you, unchanged (accent — yours #ff0000 vs your app's #0f766e)");
    expect(logs).toContain("--theme-refresh");
    // The base does NOT advance while a disagreement is unresolved, so the
    // warning repeats instead of quietly becoming the new truth.
    expect(JSON.parse(await readFile(join(dir, ".vendo", "theme.extracted.json"), "utf8")))
      .toMatchObject({ slots: { accent: "#7c3bed" } });
  });

  it("--theme-refresh takes the pinned slot and records the new base", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#ff0000"));
    await writeBase(dir, { accent: "#7c3bed", background: "#ffffff", radius: "8px" });
    await flow({
      root: dir, output: captureOutput().output, fetchImpl: offline, sync: scan, ai: false, themeRefresh: true,
    });
    expect((await read(dir)).colors.accent).toBe("#0f766e");
    expect(JSON.parse(await readFile(join(dir, ".vendo", "theme.extracted.json"), "utf8")))
      .toMatchObject({ slots: { accent: "#0f766e" } });
  });

  it("with no merge base nothing is machine-owned: the file is untouched and the diff is loud", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#7c3bed"));
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    expect((await read(dir)).colors.accent).toBe("#7c3bed");
    expect(messages.logs.join("\n")).toContain("1 pinned by you, unchanged (accent — yours #7c3bed vs your app's #0f766e)");
  });

  // BLOCKER 2 (review): the neutral defaults are ordinary Tailwind palette
  // values — #2563eb is blue-600 — so "it equals our default" is NOT proof the
  // machine wrote it. Every existing install takes this upgrade path.
  it("a human value that happens to equal Vendo's neutral default is still pinned", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#2563eb")); // blue-600: our default AND a real brand choice
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    expect((await read(dir)).colors.accent).toBe("#2563eb");
    const logs = messages.logs.join("\n");
    expect(logs).toContain("1 pinned by you, unchanged (accent — yours #2563eb vs your app's #0f766e)");
    expect(logs).not.toContain("re-read from your app");
    // And no base was written, so the warning repeats rather than baking in.
    await expect(readFile(join(dir, ".vendo", "theme.extracted.json"), "utf8")).rejects.toThrow();
  });

  it("an unrecorded slot is pinned even when the base exists for other slots", async () => {
    const dir = await themedHost("#7c3bed");
    // The base knows accent; nothing was ever recorded for background.
    await writeTheme(dir, { ...themeJson("#7c3bed"), colors: { ...themeJson("#7c3bed").colors, background: "#101010" } });
    await writeBase(dir, { accent: "#7c3bed" });
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    expect((await read(dir)).colors.background).toBe("#101010");
    expect(messages.logs.join("\n")).toContain("1 pinned by you, unchanged (background — yours #101010 vs your app's #ffffff)");
  });

  // BLOCKER 1 (review): .vendo/ is committed and predev runs sync, so a base
  // that rewrites itself every run dirties every contributor's tree.
  it("two consecutive no-op syncs leave theme.extracted.json byte-identical", async () => {
    const dir = await themedHost("#7c3bed");
    await writeTheme(dir, themeJson("#7c3bed"));
    const basePath = join(dir, ".vendo", "theme.extracted.json");
    await flow({ root: dir, output: captureOutput().output, fetchImpl: offline, sync: scan, ai: false });
    const first = await readFile(basePath, "utf8");
    await flow({ root: dir, output: captureOutput().output, fetchImpl: offline, sync: scan, ai: false });
    expect(await readFile(basePath, "utf8")).toBe(first);
    // No timestamp: the file carries decisions, nothing else.
    expect(JSON.parse(first)).toEqual({ format: "vendo/theme-extracted@1", slots: expect.any(Object) });
  });

  // N1 (review): most of the demo-app noise was hex casing.
  it("compares colors by meaning: #FFFFFF and #ffffff are not a hand edit", async () => {
    const dir = await themedHost("#7C3BED");
    await writeTheme(dir, themeJson("#7c3bed"));
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    expect(messages.logs.join("\n")).not.toContain("theme:");
  });

  it("bootstraps the base silently when the scan and theme.json already agree", async () => {
    const dir = await themedHost("#7c3bed");
    await writeTheme(dir, themeJson("#7c3bed"));
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    expect(messages.logs.join("\n")).not.toContain("theme:");
    expect(JSON.parse(await readFile(join(dir, ".vendo", "theme.extracted.json"), "utf8")))
      .toMatchObject({ slots: { accent: "#7c3bed" } });
  });

  // Review round 2: the summary line must be literally true. It named slots
  // whose BASE moved as "re-read from your app", so a user with a pinned
  // accent was told their accent now tracks their CSS. It did not.
  it("names exactly the slots written, and reports the pinned ones separately", async () => {
    const dir = await themedHost("#0f766e");
    // background is hand-edited (pinned); accent is machine-owned (written).
    const start = themeJson("#7c3bed");
    await writeTheme(dir, { ...start, colors: { ...start.colors, background: "#101010" } });
    await writeBase(dir, { accent: "#7c3bed", accentText: "#ffffff", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    const result = await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    const line = result.notes.find((n) => n.startsWith("theme:"))!;

    // Written: accent only — and the pinned slot is NOT in the re-read list.
    expect(line).toContain("1 slot re-read from your app (accent) → .vendo/theme.json");
    expect(line).not.toContain("re-read from your app (accent, background)");
    // Pinned: named separately, with BOTH values so it cannot read as "border
    // now tracks your CSS".
    expect(line).toContain("1 pinned by you, unchanged (background — yours #101010 vs your app's #ffffff)");

    const after = await read(dir);
    expect(after.colors.accent).toBe("#0f766e"); // written, as reported
    expect(after.colors.background).toBe("#101010"); // pinned, as reported
    expect(result.theme).toEqual({ updated: ["accent"], pinned: ["background"] });
  });

  // The defect underneath the wrong label: a DERIVED slot followed the app's
  // source while the source itself stayed pinned, so the human's dark accent
  // got black text written on it.
  it("holds a derived slot when the slot it derives from is pinned", async () => {
    // The app's accent is light, so its contrast text is black — but the human
    // pinned a DARK accent, whose contrast text must stay white.
    const dir = await themedHost("#fde047");
    await writeTheme(dir, themeJson("#2563eb"));
    await writeBase(dir, { accent: "#7c3bed", accentText: "#ffffff", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    const after = await read(dir);
    expect(after.colors.accent).toBe("#2563eb");
    expect(after.colors.accentText).toBe("#ffffff"); // NOT #000000 on dark blue
    expect(messages.logs.join("\n")).not.toContain("accentText");
  });

  it("a derived slot DOES follow its source when the source is machine-owned", async () => {
    const dir = await themedHost("#fde047");
    await writeTheme(dir, themeJson("#7c3bed"));
    await writeBase(dir, { accent: "#7c3bed", accentText: "#ffffff", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false });
    const after = await read(dir);
    expect(after.colors.accent).toBe("#fde047");
    expect(after.colors.accentText).toBe("#000000"); // correct contrast on yellow
    expect(messages.logs.join("\n")).toContain("2 slots re-read from your app (accent, accentText)");
  });

  it("reports both halves in --json", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#ff0000"));
    await writeBase(dir, { accent: "#7c3bed", background: "#ffffff", radius: "8px" });
    const result = await flow({ root: dir, output: captureOutput().output, fetchImpl: offline, sync: scan, ai: false });
    expect(result.theme).toEqual({ updated: [], pinned: ["accent"] });
  });

  it("a host with no theme.json is left alone (init owns creating it)", async () => {
    const dir = await themedHost("#0f766e");
    const result = await flow({ root: dir, output: captureOutput().output, fetchImpl: offline, sync: scan, ai: false });
    expect(result.theme).toBeNull();
  });
});

describe("pin baselines reach Vendo Cloud (decision 4)", () => {
  const baseline = (slot: string, hash: string) => ({
    slot,
    source: `export function ${slot}() { return null; }`,
    hash: `sha256:${hash}`,
    exportable: false,
    capturedAt: "2026-08-02T00:00:00.000Z",
    review: true,
  });

  async function hostWithBaselines(slots: Array<{ slot: string; hash: string }>): Promise<string> {
    const dir = await host();
    await mkdir(join(dir, ".vendo", "remixable"), { recursive: true });
    for (const { slot, hash } of slots) {
      await writeFile(join(dir, ".vendo", "remixable", `${slot}.json`),
        `${JSON.stringify(baseline(slot, hash), null, 2)}\n`, "utf8");
    }
    return dir;
  }

  /** The public store door as the console sees it: one records collection. */
  function fakeStore(seed: Record<string, unknown> = {}) {
    const rows = new Map<string, unknown>(Object.entries(seed));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      const body = JSON.parse(String(init?.body ?? "{}")) as { record?: { id: string; data: unknown }; id?: string };
      const stamp = { createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" };
      if (path.endsWith("/list")) {
        return new Response(JSON.stringify({
          records: [...rows.entries()].map(([id, data]) => ({ id, data, ...stamp })),
        }), { status: 200 });
      }
      if (path.endsWith("/put")) {
        rows.set(body.record!.id, body.record!.data);
        return new Response(JSON.stringify({ record: { ...body.record, ...stamp } }), { status: 200 });
      }
      if (path.endsWith("/delete")) {
        rows.delete(body.id!);
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`unexpected store call ${path}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, rows, calls };
  }

  it("pushes the captured baseline verbatim through the public store door", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const store = fakeStore();
    const messages = captureOutput();
    await flow({
      root: dir,
      output: messages.output,
      sync: scan,
      ai: false,
      apiKey: "vnd_" + "a".repeat(40),
      apiUrl: "https://console.test",
      fetchImpl: store.fetchImpl,
    });
    // The collection the console reads, and the exact shape it validates.
    expect(store.calls.some((path) => path.includes("/api/v1/store/records/vendo_pin_baselines"))).toBe(true);
    expect(store.rows.get("NetWorthCard")).toEqual(baseline("NetWorthCard", "aa"));
    expect(messages.logs.join("\n")).toContain("baselines → Vendo Cloud: 1 pushed, 0 pruned");
  });

  it("prunes remotely what is pruned locally, and re-pushes nothing unchanged", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const store = fakeStore({
      NetWorthCard: baseline("NetWorthCard", "aa"),   // already current
      LegacyHeroCard: baseline("LegacyHeroCard", "bb"), // no local file anymore
    });
    const result = await flow({
      root: dir, output: captureOutput().output, sync: scan, ai: false,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test", fetchImpl: store.fetchImpl,
    });
    expect(result.baselines).toEqual({ pushed: [], pruned: ["LegacyHeroCard"] });
    expect([...store.rows.keys()]).toEqual(["NetWorthCard"]);
    expect(store.calls.filter((path) => path.endsWith("/put"))).toEqual([]);
  });

  it("keyless/BYO stays local: no request is made at all", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const fetchImpl = vi.fn(async () => { throw new Error("keyless sync must never call the network"); }) as unknown as typeof fetch;
    const result = await flow({ root: dir, output: captureOutput().output, sync: scan, ai: false, fetchImpl });
    expect(result.baselines).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keyless with captures SAYS the baselines stayed local", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const messages = captureOutput();
    await flow({ root: dir, output: messages.output, sync: scan, ai: false });
    expect(messages.logs.join("\n")).toContain("baselines stay local");
  });

  it("a Cloud hiccup is a warning, never a failed build", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const messages = captureOutput();
    await flow({
      root: dir, output: messages.output, sync: scan, ai: false,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(messages.errors.join("\n")).toContain("pin baselines did not fully reach Vendo Cloud");
    expect(messages.errors.join("\n")).toContain("the next sync retries");
  });

  // BLOCKER 3 (review): a half-written capture on one laptop must never wipe
  // the console's review baseline. Presence of the FILE is the prune signal.
  it("a corrupt local baseline is skipped and warned — never a delete", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    await writeFile(join(dir, ".vendo", "remixable", "SpendingDonut.json"), '{"slot":"SpendingD', "utf8");
    const store = fakeStore({
      NetWorthCard: baseline("NetWorthCard", "aa"),
      SpendingDonut: baseline("SpendingDonut", "cc"),
    });
    const corrupt = await flow({
      root: dir, output: captureOutput().output, sync: scan, ai: false,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test", fetchImpl: store.fetchImpl,
    });
    // The truncated slot's row survives untouched, and nothing was pruned.
    expect([...store.rows.keys()].sort()).toEqual(["NetWorthCard", "SpendingDonut"]);
    expect(corrupt.baselines).toEqual({ pushed: [], pruned: [] });
    expect(corrupt.notes.join("\n")).toContain("unreadable baselines left untouched in Vendo Cloud: SpendingDonut");
  });

  // N3 (review): a mid-loop transport failure must not report `null` over rows
  // that really did land.
  it("keeps partial accounting when the transport dies mid-reconcile", async () => {
    const dir = await hostWithBaselines([
      { slot: "AaaCard", hash: "aa" },
      { slot: "BbbCard", hash: "bb" },
    ]);
    const store = fakeStore();
    let puts = 0;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/put") && ++puts === 2) throw new Error("ECONNRESET");
      return store.fetchImpl(url as never, init as never);
    }) as unknown as typeof fetch;
    const partial = await flow({
      root: dir, output: captureOutput().output, sync: scan, ai: false,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test", fetchImpl: flaky,
    });
    // AaaCard landed and is still reported; BbbCard did not.
    expect(partial.baselines).toEqual({ pushed: ["AaaCard"], pruned: [] });
    expect(partial.notes.join("\n")).toContain("did not fully reach Vendo Cloud");
  });

  // I2 (review): 30s per request x N slots could add minutes to a prebuild.
  it("bails out on one overall budget instead of stalling a build", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const messages = captureOutput();
    const hang = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const started = Date.now();
    await flow({
      root: dir, output: messages.output, sync: scan, ai: false,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test", fetchImpl: hang,
      baselineBudgetMs: 150,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(messages.errors.join("\n")).toContain("budget");
  });
});
