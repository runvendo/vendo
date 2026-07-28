import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "./agent.js";
import type { AssembleResult } from "./assemble.js";
import { demoPaths } from "./demo-folder.js";
import { buildFixPrompt, fixOwnedRoots, parseDemoFixArgs, runDemoFix, type DemoFixIo } from "./fix.js";
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

  it("tolerates the pnpm separator and takes --demos-repo / --skip-ship", () => {
    expect(parseDemoFixArgs(["--", "--id", "a", "--instruction", "i", "--demos-repo", "/r", "--skip-ship"], {}))
      .toEqual({ id: "a", instruction: "i", demosRepo: "/r", skipShip: true });
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

function fixIo(demosRepo: string, overrides: Partial<DemoFixIo> = {}): { io: DemoFixIo; order: string[]; stopped: () => number } {
  const order: string[] = [];
  const state = { stopped: 0 };
  const host = { baseUrl: "http://127.0.0.1:3150", stop: async () => { state.stopped += 1; } };
  const io: DemoFixIo = {
    write: () => undefined,
    env: {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    runAgent: async (job) => { order.push(`agent:${job.name}`); return { name: job.name, code: 0, output: "done", timedOut: false } as AgentRunResult; },
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
  return { io, order, stopped: () => state.stopped };
}

describe("runDemoFix", () => {
  it("edits, re-syncs, re-assembles, re-judges and re-ships", async () => {
    const demosRepo = await demoFixture();
    const { io, order } = fixIo(demosRepo);
    const result = await runDemoFix({ id: "acme", instruction: "dark sidebar", demosRepo, skipShip: false }, io);
    expect(order).toEqual(["repo", "agent:fix-acme", "sync", "assemble", "judge", "ship"]);
    expect(result.liveUrl).toBe("https://demos.vendo.run/acme");
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
      runAgent: async (job) => ({ name: job.name, code: 1, output: "budget exceeded", timedOut: false }) as AgentRunResult,
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
