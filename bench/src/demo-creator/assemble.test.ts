import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAssemble, SmokeBrokenError, SmokeTimeoutError, SmokeToolsUnreachableError, type AssembleIo } from "./assemble.js";
import type { ExecFn, ExecResult } from "./exec.js";
import { localBootEnv, type RunningHost, type SmokeTurnFn } from "./host-boot.js";
import { classifySmoke, noProgress, smokeBudgetMs, type SmokeProgress } from "./smoke.js";

/** The shape of every healthy turn: the door answered, the model streamed. */
const alive: SmokeProgress = { doorAnswered: true, turnStarted: true, toolCall: true, hostToolAnswered: true };

/** Smoke turns expressed the way the real one reports: an outcome, not a throw. */
const settles: SmokeTurnFn = async () => classifySmoke({ settled: true, timedOut: false, progress: alive });
const timesOutAlive: SmokeTurnFn = async () => classifySmoke({ settled: false, timedOut: true, progress: alive });
const deadAgent: SmokeTurnFn = async () => classifySmoke({ settled: false, timedOut: true, progress: noProgress() });
const doorErrors: SmokeTurnFn = async () => classifySmoke({
  settled: false,
  timedOut: false,
  progress: { ...noProgress(), doorAnswered: true, doorError: "POST /api/vendo/acme → 500" },
});

const manifestPath = (demosRepo: string): string =>
  path.join(demosRepo, "host", "src", "generated", "manifest.ts");

/** A vendo-demos checkout whose manifest imports `slugs`; `installed` seeds
 * host/node_modules so the install step can be observed being skipped. Each slug
 * gets a tools.json, because stage 4 reads it to learn which tool names belong to
 * the demo's OWN API — the ones the smoke turn must see answer. */
async function fakeDemosRepo(options: {
  slugs: string[];
  installed?: boolean;
  tools?: unknown;
}): Promise<string> {
  const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-assemble-"));
  await mkdir(path.dirname(manifestPath(demosRepo)), { recursive: true });
  await writeFile(
    manifestPath(demosRepo),
    options.slugs.map((slug) => `import s from "../../../demos/${slug}/screens/index.js";`).join("\n"),
  );
  for (const slug of new Set([...options.slugs, args.slug])) {
    const demo = path.join(demosRepo, "demos", slug);
    await mkdir(demo, { recursive: true });
    await writeFile(path.join(demo, "tools.json"), JSON.stringify(options.tools ?? {
      tools: [{ name: "host_listInvoices", binding: { kind: "openapi", method: "GET", path: "/api/invoices" } }],
    }));
  }
  if (options.installed === true) await mkdir(path.join(demosRepo, "host", "node_modules"), { recursive: true });
  return demosRepo;
}

function fakeExec(byCommand: Record<string, Partial<ExecResult>> = {}): { exec: ExecFn; ran: string[] } {
  const ran: string[] = [];
  const exec: ExecFn = async (command) => {
    const key = command.join(" ");
    ran.push(key);
    const result = byCommand[key] ?? {};
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { exec, ran };
}

function fakeHost(): { host: RunningHost; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async () => undefined);
  return { host: { baseUrl: "http://127.0.0.1:4311", stop }, stop };
}

/** Everything a stage-4 run needs, with the process-touching seams faked. */
function io(demosRepo: string, overrides: Partial<AssembleIo> = {}): AssembleIo {
  return {
    demosRepo,
    write: () => undefined,
    exec: fakeExec().exec,
    boot: async () => fakeHost().host,
    smokeTurn: settles,
    ...overrides,
  };
}

const args = { slug: "acme", port: 4311, smokePrompt: "Show me overdue invoices" };

describe("runAssemble", () => {
  it("skips install when the host already has node_modules", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { exec, ran } = fakeExec();
    await runAssemble(args, io(demosRepo, { exec }));
    expect(ran).toEqual(["node scripts/gen-manifest.mjs", "pnpm build"]);
  });

  it("installs the host once when node_modules is absent", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"] });
    const { exec, ran } = fakeExec();
    await runAssemble(args, io(demosRepo, { exec }));
    expect(ran[0]).toBe("pnpm install");
  });

  it("propagates a gen-manifest failure without building or booting", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { exec, ran } = fakeExec({ "node scripts/gen-manifest.mjs": { code: 1, stderr: "cannot read demos/" } });
    const boot = vi.fn(async () => fakeHost().host);
    await expect(runAssemble(args, io(demosRepo, { exec, boot }))).rejects.toThrow(/gen-manifest failed/);
    expect(ran).toEqual(["node scripts/gen-manifest.mjs"]);
    expect(boot).not.toHaveBeenCalled();
  });

  // Silently shipping a demo the host never compiled in is the failure this
  // check exists for: the page would 404 in front of the prospect.
  it("throws naming the slug when the manifest did not discover it", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["globex"], installed: true });
    const boot = vi.fn(async () => fakeHost().host);
    await expect(runAssemble(args, io(demosRepo, { boot }))).rejects.toThrow(/acme/);
    expect(boot).not.toHaveBeenCalled();
  });

  it("never boots a demo whose build failed, and reports the build tail", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { exec } = fakeExec({ "pnpm build": { code: 1, stdout: "Type error: Property 'total' does not exist" } });
    const boot = vi.fn(async () => fakeHost().host);
    await expect(runAssemble(args, io(demosRepo, { exec, boot })))
      .rejects.toThrow(/host build failed[\s\S]*Property 'total' does not exist/);
    expect(boot).not.toHaveBeenCalled();
  });

  it("stops the host and fails when the smoke turn errors", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host, stop } = fakeHost();
    const smokeTurn: SmokeTurnFn = async () => classifySmoke({
      settled: false,
      timedOut: false,
      surfacedError: "model overloaded",
      progress: alive,
    });
    await expect(runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn })))
      .rejects.toThrow(/model overloaded/);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  // The frozen contract: "ONE smoke agent turn, result discarded, gates on hard
  // error only (turn errored / no settle), NOT on content." Nothing pinned the
  // content half — a gate that started refusing turns for generating no view, or
  // prose, or a refusal card, would pass every existing test.
  it("passes a turn that settled without generating anything", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host, stop } = fakeHost();
    // A turn that answered in prose: no view, no approval, nothing to inspect.
    const result = await runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn: settles }));
    expect(result.host).toBe(host);
    expect(stop).not.toHaveBeenCalled();
    await result.host.stop();
  });

  it("cannot gate on content, because only liveness reaches it", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host } = fakeHost();
    const result = await runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn: settles }));
    // Everything the gate is told about the turn — no view, no text, no tool
    // result. A gate that cannot see content cannot start judging it.
    // `hostToolAnswered` is a fact about the wire (did the API answer), never
    // about what came back over it.
    expect(Object.keys(result.smoke.progress).sort())
      .toEqual(["doorAnswered", "hostToolAnswered", "toolCall", "turnStarted"]);
    expect(result.smoke).toEqual({
      prompt: args.smokePrompt,
      ms: expect.any(Number),
      verdict: "settled",
      attempts: 1,
      progress: alive,
    });
    await result.host.stop();
  });
});

/**
 * The defect this replaces: ONE 180s wall-clock deadline decided both questions.
 * Measured turn latencies were 104s, 129s (errored), 135s, 165s and ≥183s, so the
 * deadline sat inside the distribution and two of six runs died on demos that
 * were fine. These are the two halves of the fix, held apart.
 */
describe("runAssemble — the smoke gate tells BROKEN from SLOW", () => {
  it("passes a healthy turn that took longer than the old 180s gate allowed", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host, stop } = fakeHost();
    let budget = 0;
    // 250s: comfortably past the old deadline, comfortably inside the new budget.
    const slowButHealthy: SmokeTurnFn = async (options) => {
      budget = options.timeoutMs;
      return classifySmoke({ settled: true, timedOut: false, progress: alive });
    };
    const result = await runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn: slowButHealthy }));
    expect(budget).toBeGreaterThan(250_000);
    expect(result.smoke.verdict).toBe("settled");
    expect(stop).not.toHaveBeenCalled();
    await result.host.stop();
  });

  it("hands the smoke turn the evidence-derived budget, not the old deadline", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    let budget = 0;
    const smokeTurn: SmokeTurnFn = async (options) => {
      budget = options.timeoutMs;
      return classifySmoke({ settled: true, timedOut: false, progress: alive });
    };
    const result = await runAssemble(args, io(demosRepo, { smokeTurn }));
    expect(budget).toBe(smokeBudgetMs);
    expect(budget).not.toBe(180_000);
    await result.host.stop();
  });

  it("fails a genuinely broken agent FAST, on the signal and not on the clock", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host, stop } = fakeHost();
    const started = Date.now();
    const thrown = await runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn: doorErrors }))
      .catch((error: unknown) => error as Error);
    expect(thrown).toBeInstanceOf(SmokeBrokenError);
    expect(thrown.message).toMatch(/agent route answered/);
    // The door's 500 arrives in the first seconds; nothing waited out a budget.
    expect(Date.now() - started).toBeLessThan(smokeBudgetMs);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("calls an agent that never produced a turn broken, not slow", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const thrown = await runAssemble(args, io(demosRepo, { smokeTurn: deadAgent }))
      .catch((error: unknown) => error as Error);
    expect(thrown).toBeInstanceOf(SmokeBrokenError);
    expect(thrown).not.toBeInstanceOf(SmokeTimeoutError);
    expect(thrown.message).toMatch(/never produced a turn/);
  });

  // Not a silent pass — it still fails the run. But it fails as its own thing, so
  // the Slack thread reads "the smoke turn timed out" instead of implying that a
  // demo which compiled, booted and streamed is broken.
  it("reports a living-but-unfinished turn as a TIMEOUT, distinct from broken", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const lines: string[] = [];
    const thrown = await runAssemble(args, io(demosRepo, { smokeTurn: timesOutAlive, write: (line) => lines.push(line) }))
      .catch((error: unknown) => error as Error);
    expect(thrown).toBeInstanceOf(SmokeTimeoutError);
    expect(thrown).not.toBeInstanceOf(SmokeBrokenError);
    expect(thrown.message).toMatch(/timed out/i);
    // Never the broken verdict's own wording — and it says outright what it is,
    // so a human reading the thread cannot take it for a broken demo either.
    expect(thrown.message).not.toMatch(/is BROKEN/);
    expect(thrown.message).toMatch(/not a broken demo/);
    // …and it says so on stdout too, where the Slack driver can read it.
    expect(lines.some((line) => line.startsWith("SMOKE: TIMEOUT"))).toBe(true);
  });

  it("gives the two verdicts messages an operator cannot confuse", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const timeout = await runAssemble(args, io(demosRepo, { smokeTurn: timesOutAlive })).catch((error: unknown) => error as Error);
    const broken = await runAssemble(args, io(demosRepo, { smokeTurn: deadAgent })).catch((error: unknown) => error as Error);
    expect(timeout.message).not.toBe(broken.message);
    expect(broken.message).toMatch(/broken/i);
  });
});

/**
 * THE BLIND SPOT. A demo shipped that served 200, had a pixel-accurate palette
 * and zero console errors — and every agent tool 404'd, so it could not answer a
 * single question. The gate passed because the agent behaved WELL: it retried,
 * diagnosed the 404s and honestly refused rather than fabricating an answer. The
 * turn SETTLED, and settled was all the gate checked.
 */
describe("runAssemble — a demo whose own API never answered its agent", () => {
  const unreachable: SmokeTurnFn = async () => classifySmoke({
    settled: true,
    timedOut: false,
    progress: {
      doorAnswered: true,
      turnStarted: true,
      toolCall: true,
      hostToolAnswered: false,
      hostToolProblem: `host_listInvoices → GET /api/acme/invoices → 404: {"error":{"message":"Not found"}}`,
    },
  });

  it("fails a settled turn whose tools never answered, as its own verdict", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host, stop } = fakeHost();
    const lines: string[] = [];
    const thrown = await runAssemble(args, io(demosRepo, {
      boot: async () => host,
      smokeTurn: unreachable,
      write: (line) => lines.push(line),
    })).catch((error: unknown) => error as Error);
    expect(thrown).toBeInstanceOf(SmokeToolsUnreachableError);
    expect(thrown).not.toBeInstanceOf(SmokeBrokenError);
    expect(thrown).not.toBeInstanceOf(SmokeTimeoutError);
    expect(lines.some((line) => line.startsWith("SMOKE: TOOLS-UNREACHABLE"))).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  /**
   * CAUSE-AGNOSTIC, deliberately. The 404s that motivated this gate were first
   * diagnosed as a path-shape bug and were nothing of the kind — the real fault
   * was a wire origin pointing at another host, and the runtime's own error clause
   * reports a method, a path and a status but NEVER the origin. A message that
   * named a suspected culprit sent a diagnosis down the wrong road for hours, so
   * this one reports the request, the response and the origin the demo was served
   * on, and names no cause at all.
   */
  it("reports the failing request, its response, and the origin — and blames nothing", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const { host } = fakeHost();
    const thrown = await runAssemble(args, io(demosRepo, { boot: async () => host, smokeTurn: unreachable }))
      .catch((error: unknown) => error as Error);
    // The request and the response the runtime actually saw.
    expect(thrown.message).toContain("host_listInvoices");
    expect(thrown.message).toContain("GET /api/acme/invoices");
    expect(thrown.message).toContain("404");
    // The origin, which the runtime's clause never carries — without it a reader
    // cannot tell a wrong path from a wrong host.
    expect(thrown.message).toContain(host.baseUrl);
    // No guesses. Not the openapi file, not the routes file, not a convention.
    expect(thrown.message).not.toMatch(/openapi|routes\.ts|check your/i);
  });

  it("hands the smoke turn the names of the demo's OWN tools, read from its tools.json", async () => {
    const demosRepo = await fakeDemosRepo({
      slugs: ["acme"],
      installed: true,
      tools: {
        tools: [
          { name: "host_listWidgets", binding: { kind: "openapi", method: "GET", path: "/api/widgets" } },
          { name: "slack_SLACK_SEND_MESSAGE", binding: { kind: "connector" } },
        ],
      },
    });
    let given: readonly string[] | undefined;
    const result = await runAssemble(args, io(demosRepo, {
      smokeTurn: async (options) => {
        given = options.hostToolNames;
        return classifySmoke({ settled: true, timedOut: false, progress: alive });
      },
    }));
    // Only the tools that execute against the demo's own API; a connector tool
    // talks to Composio and could never prove this demo's API answers.
    expect(given).toEqual(["host_listWidgets"]);
    await result.host.stop();
  });

  // The known data-binding gaps must still ship. This gate asks whether the API
  // answered, never what it answered with.
  it("still passes a demo whose API answered but whose turn generated nothing", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const result = await runAssemble(args, io(demosRepo, {
      smokeTurn: async () => classifySmoke({
        settled: true,
        timedOut: false,
        progress: { doorAnswered: true, turnStarted: true, toolCall: false, hostToolAnswered: true },
      }),
    }));
    expect(result.smoke.verdict).toBe("settled");
    await result.host.stop();
  });
});

/**
 * The wire origin — `VENDO_BASE_URL` — is the base every openapi tool binding is
 * resolved against. Set to a hostname that resolved to the old router, it 404'd
 * every tool call on every demo on the fleet while every page kept rendering, and
 * no page-level check saw it. The cutover runbook tells operators to export that
 * exact variable.
 */
describe("runAssemble — the wire origin belongs to the host being booted", () => {
  it("boots the local host on its own origin even when the environment names another", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const booted: NodeJS.ProcessEnv[] = [];
    const boot: NonNullable<AssembleIo["boot"]> = async (options) => {
      booted.push(localBootEnv(options.env ?? {}, options.port));
      return fakeHost().host;
    };
    const result = await runAssemble(args, io(demosRepo, {
      boot,
      env: { VENDO_BASE_URL: "https://demos.vendo.run" },
    }));
    expect(booted[0]?.VENDO_BASE_URL).toBe("http://127.0.0.1:4311");
    await result.host.stop();
  });

  it("says out loud that it had to override the environment's wire origin", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const lines: string[] = [];
    const result = await runAssemble(args, io(demosRepo, {
      env: { VENDO_BASE_URL: "https://demos.vendo.run" },
      write: (line) => lines.push(line),
    }));
    const complaint = lines.find((line) => line.includes("WIRE ORIGIN"));
    expect(complaint).toContain("https://demos.vendo.run");
    expect(complaint).toContain("http://127.0.0.1:4311");
    await result.host.stop();
  });

  it("stays quiet when the environment names no foreign wire origin", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const lines: string[] = [];
    const result = await runAssemble(args, io(demosRepo, { env: {}, write: (line) => lines.push(line) }));
    expect(lines.some((line) => line.includes("WIRE ORIGIN"))).toBe(false);
    await result.host.stop();
  });
});

describe("runAssemble — the one bounded retry", () => {
  // Run E died exactly here: "Something went wrong and the response didn't
  // finish" at 129s, on a demo that was fine. An external inference failure is
  // not the demo's bug, and it is the one outcome a second attempt can clear.
  it("retries ONCE when the turn failed on something outside the demo", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    let attempts = 0;
    const flaky: SmokeTurnFn = async () => {
      attempts += 1;
      return attempts === 1
        ? classifySmoke({ settled: false, timedOut: false, surfacedError: "the response didn’t finish", progress: alive })
        : classifySmoke({ settled: true, timedOut: false, progress: alive });
    };
    const result = await runAssemble(args, io(demosRepo, { smokeTurn: flaky }));
    expect(attempts).toBe(2);
    expect(result.smoke.verdict).toBe("settled");
    expect(result.smoke.attempts).toBe(2);
    await result.host.stop();
  });

  it("retries at most once — a reproducible error is a real bug, not a canary", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    let attempts = 0;
    const alwaysErrors: SmokeTurnFn = async () => {
      attempts += 1;
      return classifySmoke({ settled: false, timedOut: false, surfacedError: "tools file unreadable", progress: alive });
    };
    await expect(runAssemble(args, io(demosRepo, { smokeTurn: alwaysErrors }))).rejects.toThrow(SmokeBrokenError);
    expect(attempts).toBe(2);
  });

  // A retry after a deadline costs another whole budget of wall clock inside a
  // 40-minute cap and cannot change what the clock already proved.
  it("never retries a deadline, whichever way it was classified", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    for (const smokeTurn of [timesOutAlive, deadAgent]) {
      let attempts = 0;
      const counted: SmokeTurnFn = async (options) => {
        attempts += 1;
        return await smokeTurn(options);
      };
      await expect(runAssemble(args, io(demosRepo, { smokeTurn: counted }))).rejects.toThrow();
      expect(attempts).toBe(1);
    }
  });

  it("never retries a turn that settled", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    let attempts = 0;
    const counted: SmokeTurnFn = async () => {
      attempts += 1;
      return classifySmoke({ settled: true, timedOut: false, progress: alive });
    };
    const result = await runAssemble(args, io(demosRepo, { smokeTurn: counted }));
    expect(attempts).toBe(1);
    await result.host.stop();
  });
});

describe("runAssemble — what it hands back", () => {
  it("returns the still-running host and the smoke prompt it drove", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme", "globex"], installed: true });
    const { host, stop } = fakeHost();
    const smoked: { baseUrl: string; slug: string; prompt: string }[] = [];
    const result = await runAssemble(args, io(demosRepo, {
      boot: async () => host,
      smokeTurn: async (options) => {
        smoked.push({ baseUrl: options.baseUrl, slug: options.slug, prompt: options.prompt });
        return classifySmoke({ settled: true, timedOut: false, progress: alive });
      },
    }));
    expect(result.slugs).toEqual(["acme", "globex"]);
    expect(result.host).toBe(host);
    expect(result.smoke.prompt).toBe(args.smokePrompt);
    expect(result.smoke.ms).toBeGreaterThanOrEqual(0);
    expect(smoked).toEqual([{ baseUrl: host.baseUrl, slug: "acme", prompt: args.smokePrompt }]);
    // The judge screenshots this same boot, so the caller owns the teardown.
    expect(stop).not.toHaveBeenCalled();
    await result.host.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("boots the host on the requested port", async () => {
    const demosRepo = await fakeDemosRepo({ slugs: ["acme"], installed: true });
    const booted: { demosRepo: string; port: number; logFile: string }[] = [];
    const boot: NonNullable<AssembleIo["boot"]> = async (options) => {
      booted.push(options);
      return fakeHost().host;
    };
    await runAssemble(args, io(demosRepo, { boot }));
    expect(booted[0]).toMatchObject({ demosRepo, port: 4311 });
    expect(booted[0]?.logFile).toMatch(/\.log$/);
  });
});
