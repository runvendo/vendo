import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "./agent.js";
import type { AssembleResult } from "./assemble.js";
import { demoPaths } from "./demo-folder.js";
import { buildAgentJobs } from "./build.js";
import { buildFixPrompt, fixBudgetUsd, fixOwnedRoots, parseDemoFixArgs, runDemoFix, type DemoFixIo } from "./fix.js";
import type { JudgeResult } from "./judge.js";
import type { ShipResult } from "./ship.js";

describe("parseDemoFixArgs", () => {
  it("requires a slug and a non-empty instruction", () => {
    expect(parseDemoFixArgs(["--id", "acme", "--instruction", "darker sidebar"], {}))
      .toMatchObject({ id: "acme", instruction: "darker sidebar", skipShip: false });
    expect(() => parseDemoFixArgs(["--instruction", "x"], {})).toThrow("--id is required");
    expect(() => parseDemoFixArgs(["--id", "acme"], {})).toThrow("--instruction is required");
    expect(() => parseDemoFixArgs(["--id", "acme", "--instruction", "   "], {})).toThrow("--instruction is required");
  });

  it("rejects a slug that would resolve outside the demos directory", () => {
    for (const id of ["../host/src/vendo-kit", "..", "acme/sub"]) {
      expect(() => parseDemoFixArgs(["--id", id, "--instruction", "x"], {})).toThrow(/not a valid demo slug/);
    }
  });

  it("tolerates the pnpm separator and takes --demos-repo / --skip-ship", () => {
    expect(parseDemoFixArgs(["--", "--id", "acme", "--instruction", "i", "--demos-repo", "/r", "--skip-ship"], {}))
      .toEqual({ id: "acme", instruction: "i", demosRepo: "/r", skipShip: true });
  });
});

describe("buildFixPrompt", () => {
  const prompt = buildFixPrompt({ prospect: "Acme", slug: "acme", instruction: "make the sidebar dark", brief: "BRIEF BODY" });

  it("carries the instruction as authoritative and the smallest-change rule", () => {
    expect(prompt).toContain("make the sidebar dark");
    expect(prompt).toMatch(/AUTHORITATIVE/);
    expect(prompt).toMatch(/SMALLEST change/i);
  });

  it("fences the settled brand evidence and the host", () => {
    for (const fenced of ["theme.json", "BRIEF.md", "brand/**", "RESEARCH/**", "tools.json"]) {
      expect(prompt).toContain(fenced);
    }
    expect(prompt).toContain("host/src/vendo-kit");
    expect(prompt).toContain(fixOwnedRoots.join(", "));
  });

  it("keeps the invented-data invariant and the five-beat arc", () => {
    expect(prompt).toMatch(/ALL data is INVENTED/);
    expect(prompt).toContain("generate-ui, take-action, automation, connect-account, save-app");
  });

  // The two prompts described the SAME host type differently: build said
  // `(request: Request)` — NOT a store argument — and fix said "(req, store)".
  // The host's real handler is `(request: Request, store: never)`, i.e. the
  // second parameter is unusable, so a fix agent following the old wording would
  // write a handler around a `never` and reach for a store that is not there.
  it("describes the route handler exactly as the build prompt does", () => {
    const server = buildAgentJobs({
      slug: "acme",
      prospect: "Acme",
      brief: {
        company: "Acme", oneLiner: "x", productSurface: "y", referenceScreenshot: "RESEARCH/a.png",
        nav: ["Home"], vocabulary: ["order"], voice: "terse",
        entities: [{ name: "Order", stem: "orders", action: "cancelOrder", fields: ["total: cents"], sampleRecordNames: ["ORD-1"] }],
        chipMaterial: ["orders"], placement: { trigger: "header", slot: "top bar" }, themeNotes: [],
      },
      ctaUrl: "https://cal.com/x",
      expiresAt: "2026-08-31T00:00:00Z",
    }).find((job) => job.name === "server");

    expect(prompt).toContain("`(request: Request)` — NOT a store argument");
    expect(server?.prompt).toContain("`(request: Request)` — NOT a store argument");
    expect(prompt).not.toMatch(/\(req, store\)/);
    // And both send the agent to the same place for captured segments.
    expect(prompt).toContain("searchParams");
    expect(server?.prompt).toContain("searchParams");
  });
});

// ---------------------------------------------------------------------------

async function demoFixture(options: { config?: unknown } = {}): Promise<string> {
  const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
  const paths = demoPaths(demosRepo, "acme");
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.brief, "# BRIEF — Acme\n");
  await writeFile(paths.config, JSON.stringify(options.config ?? {
    id: "acme",
    prospect: "Acme Widgets",
    ctaUrl: "https://cal.com/x",
    caps: { maxTurns: 20, maxSpendUsd: 5 },
    expiresAt: "2026-08-31T00:00:00.000Z",
    placement: { trigger: "header", slot: "top-right of the header bar" },
    beats: [
      { key: "generate-ui", chip: "Spend", prompt: "Build me a spend view", expectsView: true },
      { key: "take-action", chip: "Pay", prompt: "Pay the oldest bill", expectsApproval: true },
      { key: "automation", chip: "Watch", prompt: "Alert me on new bills" },
      { key: "connect-account", chip: "Connect", prompt: "Connect my inbox" },
      { key: "save-app", chip: "Save", prompt: "Save this as an app" },
    ],
  }));
  return demosRepo;
}

function fixIo(
  demosRepo: string,
  overrides: Partial<DemoFixIo> = {},
  options: { stopThrows?: boolean } = {},
): { io: DemoFixIo; order: string[]; stopped: () => number; lines: string[] } {
  const order: string[] = [];
  const lines: string[] = [];
  const state = { stopped: 0 };
  const host = {
    baseUrl: "http://127.0.0.1:3150",
    stop: async () => {
      state.stopped += 1;
      if (options.stopThrows === true) throw new Error("stop failed");
    },
  };
  const io: DemoFixIo = {
    write: (line) => lines.push(line),
    env: {},
    exec: async () => ({ code: 0, stdout: "?? demos/acme/\n", stderr: "" }),
    runAgent: async (job) => { order.push(`agent:${job.name}`); return { name: job.name, code: 0, output: "done", timedOut: false, permissionDenials: [] } as AgentRunResult; },
    stages: {
      ensureRepo: async (dir) => { order.push("repo"); return { dir, cloned: false, head: "h" }; },
      syncTools: async () => { order.push("sync"); return 4; },
      assemble: async () => { order.push("assemble"); return { slugs: ["acme"], host, smoke: { prompt: "p", ms: 1 } } as unknown as AssembleResult; },
      judge: async () => {
        order.push("judge");
        return { builtScreens: [], reportPath: "F.md", notes: [], scoresLine: "logo=PASS palette=8 type=8 layout=8 copyTone=8", verdict: { pass: true, failing: [], scores: [] } } as unknown as JudgeResult;
      },
      ship: async () => { order.push("ship"); return { commit: "abc", liveUrl: "https://demos.vendo.run/acme", attempts: 1 } as unknown as ShipResult; },
    },
    ...overrides,
  };
  return { io, order, lines, stopped: () => state.stopped };
}

describe("runDemoFix", () => {
  it("edits, re-syncs, re-assembles, re-judges and re-ships", async () => {
    const demosRepo = await demoFixture();
    const { io, order } = fixIo(demosRepo);
    const result = await runDemoFix({ id: "acme", instruction: "dark sidebar", demosRepo, skipShip: false }, io);
    expect(order).toEqual(["repo", "agent:fix-acme", "sync", "assemble", "judge", "ship"]);
    expect(result.liveUrl).toBe("https://demos.vendo.run/acme");
  });

  it("prints what the fix spent, next to the cap that bounded it", async () => {
    const demosRepo = await demoFixture();
    const { io, lines } = fixIo(demosRepo, {
      runAgent: async (job) => ({ name: job.name, code: 0, output: "done", costUsd: 1.08, timedOut: false, permissionDenials: [] }),
    });
    await runDemoFix({ id: "acme", instruction: "dark sidebar", demosRepo, skipShip: false }, io);
    const spend = lines.find((line) => line.startsWith("SPEND:"));
    expect(spend).toContain("$1.08");
    expect(spend).toContain(`$${fixBudgetUsd.toFixed(2)}`);
  });

  it("refuses a slug that has no demo yet and says which command makes one", async () => {
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
    const { io } = fixIo(demosRepo);
    await expect(runDemoFix({ id: "ghost", instruction: "x", demosRepo, skipShip: false }, io))
      .rejects.toThrow(/demo:pipeline to create "ghost"/);
  });

  it("propagates a failed fix agent and never assembles", async () => {
    const demosRepo = await demoFixture();
    const { io, order } = fixIo(demosRepo, {
      runAgent: async (job) => ({ name: job.name, code: 1, output: "budget exceeded", timedOut: false, permissionDenials: [] }) as AgentRunResult,
    });
    await expect(runDemoFix({ id: "acme", instruction: "x", demosRepo, skipShip: false }, io))
      .rejects.toThrow(/Fix agent failed \(exit 1\)/);
    expect(order).not.toContain("assemble");
  });

  it("--skip-ship stops after judge", async () => {
    const demosRepo = await demoFixture();
    const { io, order } = fixIo(demosRepo);
    const result = await runDemoFix({ id: "acme", instruction: "x", demosRepo, skipShip: true }, io);
    expect(order).not.toContain("ship");
    expect(result.liveUrl).toBeUndefined();
  });

  it("reports the demo folder path, so the operator has somewhere to look", async () => {
    const demosRepo = await demoFixture();
    const { io } = fixIo(demosRepo);
    const result = await runDemoFix({ id: "acme", instruction: "x", demosRepo, skipShip: true }, io);
    expect(result.demoDir).toBe(demoPaths(demosRepo, "acme").root);
  });

  // `railway up` uploads the whole working directory, so a fix agent that
  // wandered into host/ would deploy it to every live demo uncommitted. The dirt
  // appears BETWEEN the two `git status` calls, which is what makes it the
  // agent's doing rather than the checkout's inherited state: a demo:fix always
  // runs in a checkout that has already shipped a demo.
  it("refuses to assemble when the fix agent touched anything outside the demo folder", async () => {
    const demosRepo = await demoFixture();
    let statusCalls = 0;
    const { io, order } = fixIo(demosRepo, {
      exec: async (command) => {
        if (!command.includes("status")) return { code: 0, stdout: "", stderr: "" };
        statusCalls += 1;
        return { code: 0, stdout: statusCalls === 1 ? "" : " M host/src/vendo-kit/index.tsx\n", stderr: "" };
      },
    });
    await expect(runDemoFix({ id: "acme", instruction: "x", demosRepo, skipShip: false }, io))
      .rejects.toThrow(/host\/src\/vendo-kit\/index\.tsx/);
    expect(order).not.toContain("assemble");
    // The fence goes after the re-sync, which legitimately rewrites tools.json.
    expect(order).toContain("sync");
  });

  it("warns naming the port when the local host will not stop", async () => {
    const demosRepo = await demoFixture();
    const { io, lines } = fixIo(demosRepo, {}, { stopThrows: true });
    await runDemoFix({ id: "acme", instruction: "x", demosRepo, skipShip: false }, io);
    const warning = lines.find((line) => line.includes("3150") && /warn/i.test(line));
    expect(warning).toBeDefined();
    expect(warning).toContain("stop failed");
  });

  it("threads its stage runner into the stages, so sub-stage timings land in timings.json", async () => {
    const demosRepo = await demoFixture();
    const base = fixIo(demosRepo);
    const stages = base.io.stages as NonNullable<DemoFixIo["stages"]>;
    const io: DemoFixIo = {
      ...base.io,
      stages: {
        ...stages,
        assemble: async (assembleArgs, assembleIo) => {
          await assembleIo.runStage?.("assemble:build", async () => undefined);
          return await stages.assemble(assembleArgs, assembleIo);
        },
      },
    };
    await runDemoFix({ id: "acme", instruction: "x", demosRepo, skipShip: true }, io);
    const rows = JSON.parse(await readFile(demoPaths(demosRepo, "acme").timings, "utf8")) as { stage: string }[];
    expect(rows.map((row) => row.stage)).toContain("assemble:build");
  });

  it("stops the host when judge throws", async () => {
    const demosRepo = await demoFixture();
    const base = fixIo(demosRepo);
    const io: DemoFixIo = {
      ...base.io,
      stages: { ...(base.io.stages as NonNullable<DemoFixIo["stages"]>), judge: async () => { throw new Error("judge exploded"); } },
    };
    await expect(runDemoFix({ id: "acme", instruction: "x", demosRepo, skipShip: false }, io)).rejects.toThrow("judge exploded");
    expect(base.stopped()).toBe(1);
  });
});
