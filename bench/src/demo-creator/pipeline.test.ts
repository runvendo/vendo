import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AssembleResult } from "./assemble.js";
import type { BriefResult } from "./brief.js";
import type { BuildResult } from "./build.js";
import { demoPaths } from "./demo-folder.js";
import type { EvidenceResult } from "./evidence.js";
import type { ExecFn } from "./exec.js";
import type { JudgeResult } from "./judge.js";
import {
  assertOnlyDemoTouched,
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
  const full = { ANTHROPIC_API_KEY: "sk", CONTEXT_DEV_API_KEY: "ctx", VENDO_API_KEY: "vk" };

  it("names every missing credential before a single stage runs", () => {
    expect(() => preflight({})).toThrow(/ANTHROPIC_API_KEY[\s\S]*CONTEXT_DEV_API_KEY[\s\S]*VENDO_API_KEY/);
    expect(() => preflight({ ...full, ANTHROPIC_API_KEY: undefined })).toThrow("ANTHROPIC_API_KEY");
    expect(() => preflight({ ...full, CONTEXT_DEV_API_KEY: undefined })).toThrow("CONTEXT_DEV_API_KEY");
    expect(() => preflight(full)).not.toThrow();
  });

  // The old third check re-read ANTHROPIC_API_KEY, so it could only ever repeat
  // the first check's finding — the host's own key was never actually checked.
  it("checks the host's VENDO_API_KEY on its own, not as an alias for the harness key", () => {
    expect(() => preflight({ ANTHROPIC_API_KEY: "sk", CONTEXT_DEV_API_KEY: "ctx" })).toThrow("VENDO_API_KEY");
    expect(() => preflight({ ANTHROPIC_API_KEY: "sk", CONTEXT_DEV_API_KEY: "ctx" })).not.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("treats an empty string as missing (a sourced-but-blank .env is the common case)", () => {
    expect(() => preflight({ ...full, ANTHROPIC_API_KEY: "" })).toThrow("ANTHROPIC_API_KEY");
    expect(() => preflight({ ...full, VENDO_API_KEY: "" })).toThrow("VENDO_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// The host fence
// ---------------------------------------------------------------------------

describe("assertOnlyDemoTouched", () => {
  const statusExec = (porcelain: string): ExecFn => async () => ({ code: 0, stdout: porcelain, stderr: "" });

  it("passes when every change is inside the demo's own folder", async () => {
    const exec = statusExec(" M demos/acme/screens/index.tsx\n?? demos/acme/server/routes.ts\n?? demos/acme/\n");
    await expect(assertOnlyDemoTouched("/repo", "acme", { exec })).resolves.toBeUndefined();
  });

  it("throws naming a host file a generation agent had no business editing", async () => {
    const exec = statusExec(" M host/src/vendo-kit/index.tsx\n");
    await expect(assertOnlyDemoTouched("/repo", "acme", { exec }))
      .rejects.toThrow(/host\/src\/vendo-kit\/index\.tsx/);
  });

  it("throws on an untracked file dropped into ANOTHER demo", async () => {
    const exec = statusExec("?? demos/other-prospect/screens/index.tsx\n");
    await expect(assertOnlyDemoTouched("/repo", "acme", { exec }))
      .rejects.toThrow(/demos\/other-prospect\/screens\/index\.tsx/);
  });

  // `demos/acmé` must not let `demos/acme-two` through, and vice versa: the
  // fence is a path-segment boundary, not a string prefix.
  it("does not let a sibling demo whose slug starts with this one through", async () => {
    const exec = statusExec(" M demos/acme-two/screens/index.tsx\n");
    await expect(assertOnlyDemoTouched("/repo", "acme", { exec })).rejects.toThrow("demos/acme-two/screens/index.tsx");
  });

  it("parses every porcelain prefix, including a rename's arrow", async () => {
    const exec = statusExec([
      " M demos/acme/screens/index.tsx",
      "?? demos/acme/RESEARCH/evidence.json",
      "MM demos/acme/server/seed.ts",
      "R  host/src/caps.ts -> host/src/caps-guard.ts",
      "A  host/public/brand/stray.png",
      "",
    ].join("\n"));
    const error = await assertOnlyDemoTouched("/repo", "acme", { exec }).catch((thrown: unknown) => thrown as Error);
    // BOTH halves of a rename are offences — the old path was deleted from the
    // host and the new one added to it.
    expect(error.message).toContain("host/src/caps.ts");
    expect(error.message).toContain("host/src/caps-guard.ts");
    expect(error.message).toContain("host/public/brand/stray.png");
    // The demo's own files are not offenders — only the allowed root is named.
    expect(error.message).not.toContain("demos/acme/screens");
    expect(error.message).not.toContain("demos/acme/server");
    expect(error.message).not.toContain("demos/acme/RESEARCH");
  });

  // git quotes any path with a space or a non-ASCII byte: `?? "demos/acme/my
  // screen.tsx"`. Read raw, the leading quote makes a legitimate demo file look
  // like an escape, and a good run dies at minute twelve.
  it("sees through git's quoting of paths with spaces", async () => {
    const exec = statusExec('?? "demos/acme/screens/Invoice Table.tsx"\n');
    await expect(assertOnlyDemoTouched("/repo", "acme", { exec })).resolves.toBeUndefined();
    const stray = statusExec('?? "host/public/stray file.png"\n');
    await expect(assertOnlyDemoTouched("/repo", "acme", { exec: stray })).rejects.toThrow("host/public/stray file.png");
  });

  it("tells the operator what to do rather than just refusing", async () => {
    const exec = statusExec(" M host/src/vendo-kit/index.tsx\n");
    await expect(assertOnlyDemoTouched("/repo", "acme", { exec })).rejects.toThrow(/revert/i);
  });

  it("asks git about the demos repo, not the cwd", async () => {
    const calls: { command: string[]; cwd: string }[] = [];
    const exec: ExecFn = async (command, options) => {
      calls.push({ command, cwd: options.cwd });
      return { code: 0, stdout: "", stderr: "" };
    };
    await assertOnlyDemoTouched("/repo", "acme", { exec });
    expect(calls[0]?.command.slice(0, 4)).toEqual(["git", "-C", "/repo", "status"]);
    expect(calls[0]?.cwd).toBe("/repo");
  });

  it("fails loudly when git itself cannot answer", async () => {
    const exec: ExecFn = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    await expect(assertOnlyDemoTouched("/repo", "acme", { exec })).rejects.toThrow(/not a git repository/);
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

/** A demos repo whose working tree holds nothing but this demo's own folder. */
const cleanStatus: ExecFn = async () => ({ code: 0, stdout: "?? demos/acme/\n", stderr: "" });

async function run(
  overrides: Partial<PipelineStages> = {},
  argsOverride: Partial<Parameters<typeof runDemoPipeline>[0]> = {},
  options: { stopThrows?: boolean; exec?: ExecFn } = {},
) {
  const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
  const h = harness(overrides, options.stopThrows === undefined ? {} : { stopThrows: options.stopThrows });
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
    { stages: h.stages, write: (line) => lines.push(line), exec: options.exec ?? cleanStatus },
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

  // --notes is a FILE PATH. Handing the brief the literal path made the string
  // "notes.md" the authoritative operator note that wins every conflict.
  it("reads --notes from disk and hands the brief the file's CONTENTS", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-notes-"));
    const notesFile = path.join(dir, "notes.md");
    await writeFile(notesFile, "Call them Runs, never Jobs.\n");
    let seen: string | undefined;
    await run(
      {
        brief: async (briefArgs) => {
          seen = briefArgs.notes;
          return { theme: {}, brief: { company: "Acme" }, themePath: "t", briefPath: "b" } as unknown as BriefResult;
        },
      },
      { notes: notesFile },
    );
    expect(seen).toBe("Call them Runs, never Jobs.\n");
  });

  it("fails naming the --notes path when the file is not there", async () => {
    const missing = path.join(tmpdir(), "vendo-notes-that-do-not-exist.md");
    await expect(run({}, { notes: missing })).rejects.toThrow(missing);
  });

  // ship's `git add` is scoped to demos/<slug>, but `railway up` uploads the
  // whole working directory — a stray host edit would reach every live demo
  // without ever being committed.
  it("refuses to assemble when the build agents touched anything outside the demo folder", async () => {
    const dirty: ExecFn = async () => ({ code: 0, stdout: " M host/src/vendo-kit/index.tsx\n", stderr: "" });
    const promise = run({}, {}, { exec: dirty });
    await expect(promise).rejects.toThrow(/host\/src\/vendo-kit\/index\.tsx/);
  });

  it("checks the fence AFTER build and BEFORE assemble", async () => {
    const order: string[] = [];
    const spy: ExecFn = async (command) => {
      if (command.includes("status")) order.push("fence");
      return { code: 0, stdout: "", stderr: "" };
    };
    const { order: stageOrder } = await run({}, {}, { exec: spy });
    expect(order).toEqual(["fence"]);
    expect(stageOrder.indexOf("build")).toBeLessThan(stageOrder.findIndex((entry) => entry.startsWith("assemble")));
  });

  it("threads its stage runner into the stages, so sub-stage timings land in timings.json", async () => {
    const { demosRepo } = await run({
      assemble: async (_args, io) => {
        await io.runStage?.("assemble:build", async () => undefined);
        const host = { baseUrl: "http://127.0.0.1:3150", stop: async () => undefined };
        return { slugs: ["acme"], host, smoke: { prompt: "p", ms: 1 } } as unknown as AssembleResult;
      },
    });
    const rows = JSON.parse(await readFile(demoPaths(demosRepo, "acme").timings, "utf8")) as { stage: string }[];
    expect(rows.map((row) => row.stage)).toContain("assemble:build");
  });

  // judge.ts wraps its own body in runStage("judge"), the same name the pipeline
  // gives the stage — two rows, not one overwritten row.
  it("keeps a sub-stage row from colliding with its parent's row", async () => {
    const { demosRepo } = await run({
      judge: async (_args, io) => {
        await io.runStage?.("judge", async () => undefined);
        return {
          builtScreens: [], reportPath: "F.md", notes: [],
          scoresLine: "logo=PASS palette=8 type=7 layout=9 copyTone=8",
          verdict: { pass: true, failing: [], scores: [] },
        } as unknown as JudgeResult;
      },
    });
    const rows = JSON.parse(await readFile(demoPaths(demosRepo, "acme").timings, "utf8")) as { stage: string }[];
    const stages = rows.map((row) => row.stage);
    expect(stages.filter((stage) => stage === "judge")).toHaveLength(1);
    expect(stages).toContain("judge#2");
  });

  // A swallowed stop leaks `next start` on 3150 and the NEXT run dies with a
  // boot error that looks like nothing to do with this one.
  it("warns naming the port when the local host will not stop", async () => {
    const { lines } = await run({}, {}, { stopThrows: true });
    const warning = lines.find((line) => line.includes(String(localHostPort)) && /warn/i.test(line));
    expect(warning).toBeDefined();
    expect(warning).toContain("stop failed");
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
      { stages, write: () => undefined, exec: cleanStatus },
    );
    expect(stoppedBeforeShip).toBe(1);
  });

  it("stops the host when a later stage throws, so no boot is orphaned", async () => {
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
    const h = harness({ judge: async () => { throw new Error("judge exploded"); } });
    await expect(runDemoPipeline(
      { id: "acme", prospect: "Acme", screenshots: ["/a.png"], ctaUrl: "https://x.test", expiresAt: "2026-08-31T00:00:00.000Z", demosRepo, skipShip: false },
      { stages: h.stages, write: () => undefined, exec: cleanStatus },
    )).rejects.toThrow("judge exploded");
    expect(h.stopped).toBe(1);
  });

  it("fails with the cap's named gaps rather than hanging forever", async () => {
    vi.useFakeTimers();
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
    const h = harness({ evidence: async () => await new Promise(() => undefined) });
    const promise = runDemoPipeline(
      { id: "acme", prospect: "Acme", screenshots: ["/a.png"], ctaUrl: "https://x.test", expiresAt: "2026-08-31T00:00:00.000Z", demosRepo, skipShip: false },
      { stages: h.stages, write: () => undefined, exec: cleanStatus, capMs: 1_000 },
    );
    // Which side of the stage boundary the cap lands on is a race; what must
    // hold is that the run FAILS and names what never ran.
    const assertion = expect(promise).rejects.toThrow(/cap fired[\s\S]*not run: [^\n]*brief, build, assemble, judge, ship/);
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
    vi.useRealTimers();
  });
});
