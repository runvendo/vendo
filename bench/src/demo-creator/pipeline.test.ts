import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AssembleResult } from "./assemble.js";
import type { BriefResult } from "./brief.js";
import type { BuildResult } from "./build.js";
import { demoPaths } from "./demo-folder.js";
import type { EvidenceResult } from "./evidence.js";
import type { JudgeResult } from "./judge.js";
import {
  defaultExpiresAt,
  localHostPort,
  parseDemoPipelineArgs,
  parseExpires,
  preflight,
  runDemoPipeline,
  type PipelineStages,
} from "./pipeline.js";
import type { ShipResult } from "./ship.js";

const baseArgv = [
  "--id", "acme",
  "--prospect", "Acme Widgets",
  "--screenshots", "/abs/a.png,/abs/b.png",
];

describe("parseDemoPipelineArgs", () => {
  it("requires the three operator arguments and nothing else", () => {
    const args = parseDemoPipelineArgs(baseArgv, {});
    expect(args.id).toBe("acme");
    expect(args.prospect).toBe("Acme Widgets");
    expect(args.screenshots).toEqual(["/abs/a.png", "/abs/b.png"]);
    expect(args.skipShip).toBe(false);
    expect(() => parseDemoPipelineArgs(["--prospect", "Acme", "--screenshots", "/a.png"], {})).toThrow("--id is required");
    expect(() => parseDemoPipelineArgs(["--id", "acme", "--screenshots", "/a.png"], {})).toThrow("--prospect is required");
    expect(() => parseDemoPipelineArgs(["--id", "acme", "--prospect", "Acme"], {})).toThrow("--screenshots is required");
  });

  it("tolerates the pnpm `--` separator and rejects unknown options", () => {
    expect(parseDemoPipelineArgs(["--", ...baseArgv], {}).id).toBe("acme");
    expect(() => parseDemoPipelineArgs([...baseArgv, "--port", "3000"], {})).toThrow("Unknown option: --port");
    expect(() => parseDemoPipelineArgs([...baseArgv, "--url"], {})).toThrow("--url requires a value");
  });

  it("turns --expires into a UTC instant and otherwise defaults 21 days out", () => {
    expect(parseDemoPipelineArgs([...baseArgv, "--expires", "2026-08-31"], {}).expiresAt)
      .toBe("2026-08-31T00:00:00.000Z");
    expect(() => parseExpires("31/08/2026")).toThrow("--expires must be a plain date");
    const now = new Date("2026-07-27T12:00:00.000Z");
    expect(defaultExpiresAt(now)).toBe("2026-08-17T12:00:00.000Z");
  });

  it("passes --skip-ship, --notes and --cta-url through, and defaults the CTA", () => {
    const args = parseDemoPipelineArgs([...baseArgv, "--skip-ship", "--notes", "n.md", "--cta-url", "https://x.test/book"], {});
    expect(args).toMatchObject({ skipShip: true, notes: "n.md", ctaUrl: "https://x.test/book" });
    expect(parseDemoPipelineArgs(baseArgv, {}).ctaUrl).toBe("https://cal.com/yousefhelal");
  });
});

describe("preflight", () => {
  it("names every missing credential before a single stage runs", () => {
    expect(() => preflight({})).toThrow(/ANTHROPIC_API_KEY[\s\S]*CONTEXT_DEV_API_KEY/);
    expect(() => preflight({ CONTEXT_DEV_API_KEY: "ctx" })).toThrow("ANTHROPIC_API_KEY");
    expect(() => preflight({ ANTHROPIC_API_KEY: "sk" })).toThrow("CONTEXT_DEV_API_KEY");
    expect(() => preflight({ ANTHROPIC_API_KEY: "sk", CONTEXT_DEV_API_KEY: "ctx" })).not.toThrow();
  });

  it("treats an empty string as missing (a sourced-but-blank .env is the common case)", () => {
    expect(() => preflight({ ANTHROPIC_API_KEY: "", CONTEXT_DEV_API_KEY: "ctx" })).toThrow("ANTHROPIC_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// The stage drive
// ---------------------------------------------------------------------------

interface Harness {
  stages: PipelineStages;
  order: string[];
  lines: string[];
  stopped: number;
}

function harness(overrides: Partial<PipelineStages> = {}, options: { stopThrows?: boolean } = {}): Harness {
  const order: string[] = [];
  const lines: string[] = [];
  const state = { stopped: 0 };
  const evidence = { screenshots: [], palette: [], soft: [], rawFiles: [] } as unknown as EvidenceResult;
  const brief = { theme: {}, brief: { company: "Acme" }, themePath: "t", briefPath: "b" } as unknown as BriefResult;
  const built = {
    agents: [], toolCount: 4, costUsd: 1,
    beats: [{ key: "generate-ui", chip: "Spend", prompt: "Build me a spend dashboard", expectsView: true }],
  } as unknown as BuildResult;
  const host = { baseUrl: "http://127.0.0.1:3150", stop: async () => { state.stopped += 1; } };
  const assembled = { slugs: ["acme"], host, smoke: { prompt: "p", ms: 1 } } as unknown as AssembleResult;
  const judge = {
    builtScreens: [], reportPath: "F.md", notes: [],
    scoresLine: "logo=PASS palette=8 type=7 layout=9 copyTone=8",
    verdict: { pass: true, failing: [], scores: [] },
  } as unknown as JudgeResult;
  const ship = { commit: "abc123", liveUrl: "https://demos.vendo.run/acme", attempts: 1 } as unknown as ShipResult;

  const stages: PipelineStages = {
    ensureRepo: async (dir) => { order.push("repo"); return { dir, cloned: false, head: "head" }; },
    evidence: async () => { order.push("evidence"); return evidence; },
    brief: async () => { order.push("brief"); return brief; },
    build: async () => { order.push("build"); return built; },
    assemble: async (args) => {
      order.push(`assemble:${args.port}:${args.smokePrompt}`);
      return options.stopThrows === true
        ? { ...assembled, host: { ...host, stop: async () => { state.stopped += 1; throw new Error("stop failed"); } } }
        : assembled;
    },
    judge: async (args) => { order.push(`judge:${args.baseUrl}`); return judge; },
    ship: async () => { order.push("ship"); return ship; },
    ...overrides,
  };
  return { stages, order, lines, get stopped() { return state.stopped; } };
}

async function run(overrides: Partial<PipelineStages> = {}, argsOverride: Partial<Parameters<typeof runDemoPipeline>[0]> = {}) {
  const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
  const h = harness(overrides);
  const lines: string[] = [];
  const result = await runDemoPipeline(
    {
      id: "acme",
      prospect: "Acme Widgets",
      screenshots: ["/abs/a.png"],
      ctaUrl: "https://cal.com/x",
      expiresAt: "2026-08-31T00:00:00.000Z",
      demosRepo,
      skipShip: false,
      ...argsOverride,
    },
    { stages: h.stages, write: (line) => lines.push(line) },
  );
  return { result, order: h.order, lines, demosRepo, harness: h };
}

describe("runDemoPipeline", () => {
  it("runs the six stages in the contract's order and prints SCORES", async () => {
    const { result, order, lines } = await run();
    expect(order).toEqual([
      "repo", "evidence", "brief", "build",
      `assemble:${localHostPort}:Build me a spend dashboard`,
      "judge:http://127.0.0.1:3150",
      "ship",
    ]);
    expect(result.liveUrl).toBe("https://demos.vendo.run/acme");
    expect(lines).toContain("SCORES: logo=PASS palette=8 type=7 layout=9 copyTone=8");
  });

  it("smokes the demo's OWN first beat — the prompt a prospect will click", async () => {
    const { order } = await run({
      build: async () => ({
        agents: [], toolCount: 2, costUsd: 0,
        beats: [{ key: "generate-ui", chip: "c", prompt: "Show me overdue bills", expectsView: true }],
      } as unknown as BuildResult),
    });
    expect(order).toContain(`assemble:${localHostPort}:Show me overdue bills`);
  });

  it("writes one timings row per stage to RESEARCH/timings.json", async () => {
    const { demosRepo } = await run();
    const rows = JSON.parse(await readFile(demoPaths(demosRepo, "acme").timings, "utf8")) as { stage: string; ms: number }[];
    expect(rows.map((row) => row.stage)).toEqual(["repo", "evidence", "brief", "build", "assemble", "judge", "ship"]);
    for (const row of rows) expect(typeof row.ms).toBe("number");
  });

  it("--skip-ship stops after judge and never ships", async () => {
    const { result, order, lines } = await run({}, { skipShip: true });
    expect(order).not.toContain("ship");
    expect(result.liveUrl).toBeUndefined();
    expect(lines.some((line) => line.includes("--skip-ship"))).toBe(true);
  });

  it("stops the booted host before shipping — one dev server, reaped", async () => {
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
    const h = harness();
    let stoppedBeforeShip: number | undefined;
    const stages: PipelineStages = { ...h.stages, ship: async (...ship) => { stoppedBeforeShip = h.stopped; return h.stages.ship(...ship); } };
    await runDemoPipeline(
      { id: "acme", prospect: "Acme", screenshots: ["/a.png"], ctaUrl: "https://x.test", expiresAt: "2026-08-31T00:00:00.000Z", demosRepo, skipShip: false },
      { stages, write: () => undefined },
    );
    expect(stoppedBeforeShip).toBe(1);
  });

  it("stops the host when a later stage throws, so no boot is orphaned", async () => {
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
    const h = harness({ judge: async () => { throw new Error("judge exploded"); } });
    await expect(runDemoPipeline(
      { id: "acme", prospect: "Acme", screenshots: ["/a.png"], ctaUrl: "https://x.test", expiresAt: "2026-08-31T00:00:00.000Z", demosRepo, skipShip: false },
      { stages: h.stages, write: () => undefined },
    )).rejects.toThrow("judge exploded");
    expect(h.stopped).toBe(1);
  });

  it("fails with the cap's named gaps rather than hanging forever", async () => {
    vi.useFakeTimers();
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
    const h = harness({ evidence: async () => await new Promise(() => undefined) });
    const promise = runDemoPipeline(
      { id: "acme", prospect: "Acme", screenshots: ["/a.png"], ctaUrl: "https://x.test", expiresAt: "2026-08-31T00:00:00.000Z", demosRepo, skipShip: false },
      { stages: h.stages, write: () => undefined, capMs: 1_000 },
    );
    // Which side of the stage boundary the cap lands on is a race; what must
    // hold is that the run FAILS and names what never ran.
    const assertion = expect(promise).rejects.toThrow(/cap fired[\s\S]*not run: [^\n]*brief, build, assemble, judge, ship/);
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
    vi.useRealTimers();
  });
});
