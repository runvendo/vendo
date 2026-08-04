import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun, readGitStateFromCli, type GitState } from "./run";
import { listRuns, loadRun, saveRun, setPin } from "./store";
import type { AppDocument } from "@vendoai/core";
import type { Finding } from "@vendoai/apps";
import type { HostFixture, HostName, LaneAdapter, RunRecord, RunRequest } from "./types";
import { stubHostFixture } from "../fixtures/stub";

const DOCUMENT: AppDocument = {
  format: "vendo/app@2",
  name: "Balances",
  tree: { component: "Stack", props: {} },
} as unknown as AppDocument;

const FINDINGS: Finding[] = [
  { severity: "warn", where: 'node "n2" prop "rows"', message: "balances may be empty" },
];

const fixture: HostFixture = stubHostFixture("maple");

const fixtures: Partial<Record<HostName, HostFixture>> = { maple: fixture };

const cleanGit: GitState = { sha: "abc123", dirty: null };

function okAdapter(overrides: Partial<LaneAdapter> = {}): LaneAdapter {
  return {
    name: "vendo",
    async generate() {
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: "ok" as const,
        startedAt,
        durationMs: 5,
        document: DOCUMENT,
        wire: "wire text",
        findings: FINDINGS,
      };
    },
    ...overrides,
  };
}

function rejectingAdapter(): LaneAdapter {
  return {
    name: "thesys-c1",
    async generate() {
      throw new Error("boom: api down");
    },
  };
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return { prompt: "show my balances", host: "maple", lanes: ["vendo"], ...overrides };
}

function tempRunsDir(): string {
  return mkdtempSync(join(tmpdir(), "genui-bench-runs-"));
}

describe("executeRun", () => {
  it("runs enabled lanes concurrently", async () => {
    // Adapter A only resolves once B has started: a serial runner deadlocks
    // (vitest timeout fails the test), a concurrent one sails through.
    let bStarted: () => void;
    const bStartedPromise = new Promise<void>((resolve) => { bStarted = resolve; });
    const a: LaneAdapter = {
      name: "vendo",
      async generate() {
        await bStartedPromise;
        return { status: "ok", startedAt: Date.now(), durationMs: 1 };
      },
    };
    const b: LaneAdapter = {
      name: "copilotkit",
      async generate() {
        bStarted();
        return { status: "ok", startedAt: Date.now(), durationMs: 1 };
      },
    };

    const record = await executeRun(
      request({ lanes: ["vendo", "copilotkit"] }),
      fixtures,
      [a, b],
      tempRunsDir(),
      { readGitState: () => cleanGit },
    );
    expect(record.lanes.vendo?.status).toBe("ok");
    expect(record.lanes.copilotkit?.status).toBe("ok");
  }, 2_000);

  it("never rejects and marks a rejecting lane failed with the error message", async () => {
    const record = await executeRun(
      request({ lanes: ["vendo", "thesys-c1"] }),
      fixtures,
      [okAdapter(), rejectingAdapter()],
      tempRunsDir(),
      { readGitState: () => cleanGit },
    );

    expect(record.lanes.vendo?.status).toBe("ok");
    const failed = record.lanes["thesys-c1"];
    expect(failed?.status).toBe("failed");
    if (failed?.status === "failed") expect(failed.error).toContain("boom: api down");
  });

  it("marks a lane with no registered adapter failed", async () => {
    const record = await executeRun(
      request({ lanes: ["tambo"] }),
      fixtures,
      [],
      tempRunsDir(),
      { readGitState: () => cleanGit },
    );
    const lane = record.lanes.tambo;
    expect(lane?.status).toBe("failed");
    if (lane?.status === "failed") expect(lane.error).toContain("tambo");
  });

  it("persists run.json plus per-lane artifact files, keeping run.json slim", async () => {
    const runsDir = tempRunsDir();
    const record = await executeRun(
      request({ lanes: ["vendo"] }),
      fixtures,
      [okAdapter()],
      runsDir,
      { readGitState: () => cleanGit },
    );

    const runDir = join(runsDir, record.id);
    const slim = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    expect(slim.id).toBe(record.id);
    expect(slim.lanes.vendo.status).toBe("ok");
    // Bulky fields live in sibling artifact files, not run.json.
    expect(slim.lanes.vendo.document).toBeUndefined();
    expect(slim.lanes.vendo.wire).toBeUndefined();
    expect(slim.lanes.vendo.findings).toBeUndefined();

    expect(readFileSync(join(runDir, "vendo.wire.txt"), "utf8")).toBe("wire text");
    expect(JSON.parse(readFileSync(join(runDir, "vendo.document.json"), "utf8"))).toEqual(DOCUMENT);
    expect(JSON.parse(readFileSync(join(runDir, "vendo.findings.json"), "utf8"))).toEqual(FINDINGS);
  });

  it("writes <lane>.raw.json for competitor payloads", async () => {
    const runsDir = tempRunsDir();
    const raw = { messages: [{ role: "assistant", content: "hi" }] };
    const adapter: LaneAdapter = {
      name: "thesys-c1",
      async generate() {
        return { status: "ok", startedAt: Date.now(), durationMs: 1, raw };
      },
    };
    const record = await executeRun(
      request({ lanes: ["thesys-c1"] }),
      fixtures,
      [adapter],
      runsDir,
      { readGitState: () => cleanGit },
    );
    const rawPath = join(runsDir, record.id, "thesys-c1.raw.json");
    expect(JSON.parse(readFileSync(rawPath, "utf8"))).toEqual(raw);
  });

  it("stamps gitSha and gitDirty from the git state reader", async () => {
    const clean = await executeRun(request(), fixtures, [okAdapter()], tempRunsDir(), {
      readGitState: () => cleanGit,
    });
    expect(clean.gitSha).toBe("abc123");
    expect(clean.gitDirty).toBeNull();

    const dirty = await executeRun(request(), fixtures, [okAdapter()], tempRunsDir(), {
      readGitState: () => ({ sha: "def456", dirty: "d1ffhash" }),
    });
    expect(dirty.gitSha).toBe("def456");
    expect(dirty.gitDirty).toBe("d1ffhash");
  });

  it("marks all lanes failed for an unknown host fixture instead of throwing", async () => {
    const record = await executeRun(
      request({ host: "cadence" }),
      fixtures,
      [okAdapter()],
      tempRunsDir(),
      { readGitState: () => cleanGit },
    );
    const lane = record.lanes.vendo;
    expect(lane?.status).toBe("failed");
    if (lane?.status === "failed") expect(lane.error).toContain("cadence");
  });
});

describe("store", () => {
  function record(id: string, createdAt: string, extras: Partial<RunRecord> = {}): RunRecord {
    return {
      id,
      createdAt,
      gitSha: "abc123",
      gitDirty: null,
      request: request(),
      lanes: { vendo: { status: "ok", startedAt: 0, durationMs: 5 } },
      ...extras,
    };
  }

  it("setPin round-trips through run.json", async () => {
    const runsDir = tempRunsDir();
    saveRun(runsDir, record("20260726-000001-aaaa", "2026-07-26T00:00:01.000Z"));

    setPin(runsDir, "20260726-000001-aaaa", "baseline");
    expect(loadRun(runsDir, "20260726-000001-aaaa").pin).toBe("baseline");

    setPin(runsDir, "20260726-000001-aaaa", undefined);
    expect(loadRun(runsDir, "20260726-000001-aaaa").pin).toBeUndefined();
  });

  it("listRuns sorts newest-first", async () => {
    const runsDir = tempRunsDir();
    saveRun(runsDir, record("20260725-090000-aaaa", "2026-07-25T09:00:00.000Z"));
    saveRun(runsDir, record("20260726-110000-bbbb", "2026-07-26T11:00:00.000Z"));
    saveRun(runsDir, record("20260726-100000-cccc", "2026-07-26T10:00:00.000Z"));

    expect(listRuns(runsDir).map((run) => run.id)).toEqual([
      "20260726-110000-bbbb",
      "20260726-100000-cccc",
      "20260725-090000-aaaa",
    ]);
  });

  it("loadRun rehydrates bulky artifacts back onto the record", async () => {
    const runsDir = tempRunsDir();
    const full = record("20260726-120000-dddd", "2026-07-26T12:00:00.000Z", {
      lanes: {
        vendo: {
          status: "ok",
          startedAt: 0,
          durationMs: 5,
          document: DOCUMENT,
          wire: "wire text",
          findings: FINDINGS,
        },
        "thesys-c1": { status: "ok", startedAt: 0, durationMs: 7, raw: { answer: 42 } },
      },
    });
    const runJsonPath = saveRun(runsDir, full);
    expect(existsSync(runJsonPath)).toBe(true);

    const loaded = loadRun(runsDir, full.id);
    const vendo = loaded.lanes.vendo;
    expect(vendo?.status).toBe("ok");
    if (vendo?.status === "ok") {
      expect(vendo.document).toEqual(DOCUMENT);
      expect(vendo.wire).toBe("wire text");
      expect(vendo.findings).toEqual(FINDINGS);
    }
    const competitor = loaded.lanes["thesys-c1"];
    if (competitor?.status === "ok") expect(competitor.raw).toEqual({ answer: 42 });
  });
});

describe("readGitStateFromCli", () => {
  /**
   * The ENOBUFS trap, pinned. Node's default maxBuffer is 1 MB and `git diff`
   * prints the whole working diff, so ONE large tracked-but-uncommitted file
   * used to kill this call — and with it whatever unrelated target happened to
   * be running. Reverting the maxBuffer on run.ts makes this throw
   * `spawnSync git ENOBUFS`.
   */
  it("survives a tracked diff larger than Node's default 1 MB buffer", () => {
    const repo = mkdtempSync(join(tmpdir(), "genui-bench-git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "bench@example.com");
    git("config", "user.name", "bench");
    writeFileSync(join(repo, "log.txt"), "");
    git("add", "log.txt");
    git("commit", "-qm", "seed");
    // 3 MB of tracked churn — comfortably past the 1 MB default, well under 64 MB.
    writeFileSync(join(repo, "log.txt"), `${"gate log line\n".repeat(220_000)}`);

    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const state = readGitStateFromCli();
      expect(state.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(state.dirty).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
