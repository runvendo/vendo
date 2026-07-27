import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultExec } from "./deploy.js";
import {
  DemoParkedError,
  parseDemoPipelineArgs,
  runDemoPipeline,
  validateProspectUrl,
  type PipelineStages,
} from "./pipeline.js";

describe("parseDemoPipelineArgs", () => {
  it("parses the full pipeline invocation", () => {
    expect(parseDemoPipelineArgs([
      "--id", "linear",
      "--prospect", "Linear",
      "--url", "https://linear.app",
      "--screenshots", "/tmp/a.png,/tmp/b.png",
      "--skip-deploy",
    ])).toEqual({
      id: "linear",
      prospect: "Linear",
      url: "https://linear.app",
      screenshots: ["/tmp/a.png", "/tmp/b.png"],
      skipDeploy: true,
      skipCapture: false,
      targetDir: "apps",
      port: 3150,
    });
  });

  it("refuses port 3000 (capture-harness lock)", () => {
    expect(() => parseDemoPipelineArgs(["--id", "x", "--prospect", "X", "--url", "https://x.example", "--port", "3000"]))
      .toThrow("3000");
  });

  it("requires --id, --prospect and --url", () => {
    expect(() => parseDemoPipelineArgs(["--prospect", "Linear", "--url", "https://linear.app"]))
      .toThrow("--id is required");
    expect(() => parseDemoPipelineArgs(["--id", "linear", "--url", "https://linear.app"]))
      .toThrow("--prospect is required");
    expect(() => parseDemoPipelineArgs(["--id", "linear", "--prospect", "Linear"]))
      .toThrow("--url is required");
  });
});

describe("validateProspectUrl", () => {
  it("passes when HEAD answers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(validateProspectUrl("https://linear.app", { fetchImpl })).resolves.toBeUndefined();
  });

  it("treats a HEAD 405 as reachable without needing the GET fallback", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 405 }));
    await expect(validateProspectUrl("https://linear.app", { fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to GET when HEAD itself errors and passes on a page response", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(new Response("<html/>", { status: 200 }));
    await expect(validateProspectUrl("https://linear.app", { fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a bot-challenge status as reachable (403 still proves a live site)", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(validateProspectUrl("https://linear.app", { fetchImpl })).resolves.toBeUndefined();
  });

  it("fails on network errors, naming the URL", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(validateProspectUrl("https://unreachable.invalid", { fetchImpl }))
      .rejects.toThrow(/https:\/\/unreachable\.invalid.*unreachable|unreachable.*https:\/\/unreachable\.invalid/);
  });

  it("fails on a server that only ever 5xxes, naming the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(validateProspectUrl("https://down.example", { fetchImpl }))
      .rejects.toThrow(/https:\/\/down\.example/);
  });
});

/** Stage stubs that actually create the app dir (like runDemoCreate would)
 * so the abort-cleanup path has something real to remove. */
function stubStages(repoRoot: string, overrides: Partial<PipelineStages> = {}): PipelineStages {
  const appDir = path.join(repoRoot, "apps", "demo-linear");
  return {
    create: vi.fn(async () => {
      await mkdir(path.join(appDir, "RESEARCH"), { recursive: true });
      return {
        appDir,
        packageName: "demo-linear",
        configPath: path.join(appDir, "demo.config.json"),
        researchReadme: path.join(appDir, "RESEARCH", "README.md"),
      };
    }),
    research: vi.fn(async () => ({
      researchDir: path.join(appDir, "RESEARCH"),
      reportPath: path.join(appDir, "RESEARCH", "research.json"),
      report: {
        capturedAt: "2026-07-26T00:00:00.000Z",
        urls: ["https://linear.app"],
        operatorScreenshots: [],
        pages: [],
        palette: { colors: [], fontFamilies: [] },
        fonts: { families: [], faceSrcs: [], webfontLinks: [] },
      },
    })),
    judge: vi.fn(async () => ({
      rounds: [],
      parked: false,
      reportPath: path.join(appDir, "RESEARCH", "FIDELITY.md"),
      costUsd: 0,
    })),
    deploy: vi.fn(async () => ({
      serviceName: "demo-linear",
      appPath: "apps/demo-linear",
      dryRun: false,
      domain: "demo-linear.up.railway.app",
      registryPayload: { id: "linear", url: "https://demo-linear.up.railway.app", prospect: "Linear" },
    })),
    gate: vi.fn(async () => ({
      steps: [{ step: "generation-complete", ok: true, detail: "view painted" }],
      reportPath: path.join(appDir, "RESEARCH", "gate", "GATE.md"),
    })),
    rewrite: vi.fn(async (_args, io) => {
      // Exercise the pipeline's stage runner passthrough like the real
      // rewrite does for its substages.
      await io.runStage?.("rewrite:agents", async () => undefined);
      return {
        plan: {
          entity: { name: "Issue", stem: "issues", action: "closeIssue", fields: [], sampleRecordNames: ["x"] },
          screens: [{ slug: "board", route: "/", title: "Board", purpose: "clone" }],
          nav: ["Inbox"],
          copyTone: "terse",
        },
        agents: [],
        fencedViolations: [],
        buildRounds: 1,
        costUsd: 0,
      };
    }),
    ...overrides,
  };
}

const pipelineArgs = {
  id: "linear",
  prospect: "Linear",
  url: "https://linear.app",
  targetDir: "apps",
  skipDeploy: true,
  skipCapture: true,
  port: 3150,
};

describe("runDemoPipeline", () => {
  async function makeRepoRoot(): Promise<string> {
    return await mkdtemp(path.join(tmpdir(), "vendo-demo-pipeline-"));
  }

  it("fails fast on an unreachable URL: names it, exits before create, leaves nothing", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot);
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(runDemoPipeline(pipelineArgs, {
      repoRoot,
      stages,
      fetchImpl,
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: () => {},
    })).rejects.toThrow(/https:\/\/linear\.app/);
    expect(stages.create).not.toHaveBeenCalled();
    expect(existsSync(path.join(repoRoot, "apps", "demo-linear"))).toBe(false);
  });

  it("removes the app dir when an early stage aborts after create", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot, {
      research: vi.fn(async () => { throw new Error("demo:research failed for every URL"); }),
    });
    await expect(runDemoPipeline(pipelineArgs, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: () => {},
    })).rejects.toThrow("demo:research failed");
    expect(existsSync(path.join(repoRoot, "apps", "demo-linear"))).toBe(false);
  });

  it("keeps the app dir when the rewrite fails — evidence for the park report", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot, {
      rewrite: vi.fn(async () => { throw new Error("2 rewrite agent(s) failed"); }),
    });
    await expect(runDemoPipeline(pipelineArgs, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: () => {},
    })).rejects.toThrow("rewrite agent(s) failed");
    expect(existsSync(path.join(repoRoot, "apps", "demo-linear"))).toBe(true);
  });

  it("parks (typed error, app dir kept, no deploy path) when the judge stays below the bar", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot, {
      judge: vi.fn(async () => ({
        rounds: [],
        parked: true,
        reportPath: path.join(repoRoot, "apps", "demo-linear", "RESEARCH", "FIDELITY.md"),
        costUsd: 2,
      })),
    });
    await expect(runDemoPipeline(pipelineArgs, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: () => {},
    })).rejects.toThrow(DemoParkedError);
    expect(existsSync(path.join(repoRoot, "apps", "demo-linear"))).toBe(true);
  });

  it("runs capture → deploy → final gate on a full (non-skip) run, retrying a flaky deploy once", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot);
    (stages.deploy as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("railway up: BadRecordMac"))
      .mockResolvedValueOnce({
        serviceName: "demo-linear",
        appPath: "apps/demo-linear",
        dryRun: false,
        domain: "demo-linear.up.railway.app",
        registryPayload: { id: "linear", url: "https://demo-linear.up.railway.app", prospect: "Linear" },
      });
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const result = await runDemoPipeline({ ...pipelineArgs, skipDeploy: false, skipCapture: false }, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec,
      write: () => {},
      deployRetryWaitMs: 1,
    });
    expect(stages.deploy).toHaveBeenCalledTimes(2);
    expect(stages.gate).toHaveBeenCalledWith(
      expect.objectContaining({ demoUrl: "https://demos.vendo.run/linear" }),
      expect.anything(),
    );
    expect(result.demoUrl).toBe("https://demos.vendo.run/linear");
    expect(result.gifPath).toContain("demo-beats-linear.gif");
    // The capture stage ran the demo-beats CLI:
    expect(exec.mock.calls.some((call) => (call[0] as string[]).includes("demo:capture"))).toBe(true);
    const timings = JSON.parse(await readFile(path.join(result.appDir, "timings.json"), "utf8"));
    expect(timings.map((row: { stage: string }) => row.stage))
      .toEqual(["validate", "create", "install", "research", "rewrite:agents", "capture", "deploy", "final-gate"]);
  });

  it("skips deploy and gate under --skip-deploy", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot);
    const result = await runDemoPipeline(pipelineArgs, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: () => {},
    });
    expect(stages.deploy).not.toHaveBeenCalled();
    expect(stages.gate).not.toHaveBeenCalled();
    expect(result.demoUrl).toBeUndefined();
  });

  it("parks when the cap fires DURING an in-flight stage AND cancels it: the stage's subprocess verifiably exits, gaps are named, deploy never runs", async () => {
    const repoRoot = await makeRepoRoot();
    // Research spawns a REAL long-lived subprocess through the pipeline's
    // threaded signal — exactly how child-spawning stages run. The cap must
    // kill it, not merely stop awaiting it.
    let researchChild: Promise<{ code: number }> | undefined;
    const stages = stubStages(repoRoot, {
      research: vi.fn((_args: unknown, options: { signal?: AbortSignal }) => {
        researchChild = defaultExec(["sleep", "30"], { cwd: repoRoot, ...(options.signal === undefined ? {} : { signal: options.signal }) });
        return researchChild.then(() => { throw new Error("killed"); }) as never;
      }),
    });
    const started = Date.now();
    const rejection = await runDemoPipeline({ ...pipelineArgs, skipDeploy: false, skipCapture: false }, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), // install etc.; research spawns via defaultExec directly
      write: () => {},
      capMs: 700, // fires while research's sleep(30) is in flight
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DemoParkedError);
    expect(String(rejection)).toMatch(/wall-clock cap during stage "research" \(aborted mid-stage\)/);
    expect(String(rejection)).toMatch(/not run:.*deploy/);
    // Side effects ceased: the subprocess exited (a live sleep would hold
    // this await for 30s) — and no deploy artifact exists.
    const child = await researchChild;
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(child?.code).not.toBe(0);
    expect(stages.deploy).not.toHaveBeenCalled();
    // Park keeps the evidence: the app dir survives with its timings so far.
    expect(existsSync(path.join(repoRoot, "apps", "demo-linear", "timings.json"))).toBe(true);
  });

  it("gives repeated stage occurrences distinct #n names — one honest row per run", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot, {
      rewrite: vi.fn(async (_args, io) => {
        await io.runStage?.("judge:round-1", async () => undefined);
        await io.runStage?.("judge:round-1", async () => undefined);
        return {
          plan: { entity: { name: "Issue", stem: "issues", action: "closeIssue", fields: [], sampleRecordNames: ["x"] }, screens: [{ slug: "board", route: "/", title: "Board", purpose: "clone" }], nav: ["Inbox"], copyTone: "terse" },
          agents: [],
          fencedViolations: [],
          buildRounds: 1,
          costUsd: 0,
        };
      }),
    });
    const result = await runDemoPipeline(pipelineArgs, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: () => {},
    });
    const timings = JSON.parse(await readFile(path.join(result.appDir, "timings.json"), "utf8")) as { stage: string }[];
    const names = timings.map((row) => row.stage);
    expect(names.filter((name) => name.startsWith("judge:round-1"))).toEqual(["judge:round-1", "judge:round-1#2"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("writes per-stage timings and one-line progress markers", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot);
    const lines: string[] = [];
    const result = await runDemoPipeline(pipelineArgs, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: (line) => lines.push(line),
    });
    const timings = JSON.parse(await readFile(path.join(result.appDir, "timings.json"), "utf8"));
    expect(timings.map((row: { stage: string }) => row.stage))
      .toEqual(["validate", "create", "install", "research", "rewrite:agents"]);
    for (const row of timings) {
      expect(row).toMatchObject({
        stage: expect.any(String),
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        ms: expect.any(Number),
      });
    }
    for (const stage of ["validate", "create", "install", "research"]) {
      expect(lines.some((line) => line.includes(stage) && /\bms\b|\dms/.test(line)), `marker for ${stage}`).toBe(true);
    }
  });

  it("passes operator screenshots through to create", async () => {
    const repoRoot = await makeRepoRoot();
    const stages = stubStages(repoRoot);
    await runDemoPipeline({ ...pipelineArgs, screenshots: ["/tmp/a.png"] }, {
      repoRoot,
      stages,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: () => {},
    });
    expect(stages.create).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: ["/tmp/a.png"] }),
      expect.anything(),
    );
  });
});
