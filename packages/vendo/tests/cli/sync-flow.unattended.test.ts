import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

/**
 * `--yes` promises every prompt is already answered. It kept that promise for
 * the consent question and broke it one step later: with `--ai` granting
 * consent, an interactive run reached the aggregated loosening review and
 * BLOCKED on "Apply N loosenings…" the moment the judgment pass proposed waking
 * a disabled tool or lowering a risk grade. An unattended run has nobody to ask.
 *
 * Auto-applying is not the alternative — this repo's guard law is that risk is
 * never lowered without a human — so an unattended run must QUEUE loosenings
 * (held as `pending`, nothing applied) and say so. These tests pin the mode the
 * pass is asked for, plus the absence of any `confirm` seam it could block on.
 */

const runJudgmentPass = vi.hoisted(() => vi.fn());
vi.mock("../../src/cli/judge/pass.js", () => ({ runJudgmentPass }));

const selectJudgmentEngines = vi.hoisted(() => vi.fn());
vi.mock("../../src/cli/judge/engine.js", () => ({ selectJudgmentEngines }));

const runProseStages = vi.hoisted(() => vi.fn());
vi.mock("../../src/cli/init-judgment.js", () => ({ runProseStages }));

const { runSyncFlow } = await import("../../src/cli/sync-flow.js");

async function projectWithTools(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-loosening-"));
  // Registered here, not at the end of the test body: these cases assert on
  // rejected judgments, and a throwing assertion skips anything trailing.
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".vendo"), { recursive: true });
  await writeFile(
    join(root, ".vendo", "tools.json"),
    JSON.stringify({ format: 3, tools: [] }),
    "utf8",
  );
  return root;
}

function silentOutput(): { log: (line: string) => void; error: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), error: (line) => lines.push(line), lines };
}

const emptyReport = {
  tools: { added: [], removed: [], changed: [] },
  breaking: [],
  toolSchemas: { total: 0, inputs: { known: 0, unknown: [] }, outputs: { known: 0, unknown: [] } },
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 0, registered: 0 },
  components: { captured: [], drifted: [] },
  warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  selectJudgmentEngines.mockResolvedValue([
    { family: "claude", credential: "Claude Code", harness: { id: "claude-cli" } },
  ]);
  runJudgmentPass.mockResolvedValue({
    status: "judged",
    judged: 1,
    hardened: 0,
    queued: 2,
    approved: 0,
    rejectedBySkeptic: 0,
    unexaminedRejected: 0,
    evidenceless: 0,
    advisoriesClamped: 0,
    inconsistentRisk: 0,
  });
  runProseStages.mockResolvedValue({});
});

/** The flow as `vendo init` runs it: full mode, consent granted by flag. */
function initFlow(overrides: { root: string; output: ReturnType<typeof silentOutput>; yes: boolean; interactive: boolean; confirm?: unknown }) {
  return runSyncFlow({
    root: overrides.root,
    output: overrides.output,
    mode: "full",
    yes: overrides.yes,
    interactive: overrides.interactive,
    ai: true,
    sync: (async () => emptyReport) as never,
    fetchImpl: (async () => { throw new Error("offline"); }) as never,
    ...(overrides.confirm === undefined ? {} : { confirm: overrides.confirm as never }),
  });
}

describe("the loosening review never blocks an unattended run", () => {
  it("queues loosenings under --yes even in a TTY, and offers no confirm to block on", async () => {
    const root = await projectWithTools();
    const output = silentOutput();
    // The exact broken combination: consent granted by flag, --yes set, and a
    // real TTY (so the old `interactive ? "review" : "queue"` chose "review").
    // A confirm seam IS supplied, as init does whenever it has pretty output —
    // it must not be forwarded.
    const confirm = vi.fn(async () => true);

    const result = await initFlow({ root, output, yes: true, interactive: true, confirm });

    expect(result.judged.ran).toBe(true);
    expect(runJudgmentPass).toHaveBeenCalledTimes(1);
    const passed = runJudgmentPass.mock.calls[0]![0] as { loosenings: string; confirm?: unknown };
    expect(passed.loosenings).toBe("queue");
    expect(passed.confirm).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    // The pass owns the count + `vendo sync --review` line; this is the WHY,
    // so a queued result never reads as a refusal or a silent apply.
    expect(output.lines.join("\n")).toContain("held, not applied");
    expect(output.lines.join("\n")).toContain("re-run `vendo init` in a terminal");
  });

  it("queues loosenings in a non-TTY run", async () => {
    const root = await projectWithTools();
    const output = silentOutput();

    await initFlow({ root, output, yes: false, interactive: false, confirm: vi.fn(async () => true) });

    const passed = runJudgmentPass.mock.calls[0]![0] as { loosenings: string; confirm?: unknown };
    expect(passed.loosenings).toBe("queue");
    expect(passed.confirm).toBeUndefined();
  });

  it("still reviews inline when a human is actually there", async () => {
    const root = await projectWithTools();
    const output = silentOutput();
    const confirm = vi.fn(async () => true);

    await initFlow({ root, output, yes: false, interactive: true, confirm });

    const passed = runJudgmentPass.mock.calls[0]![0] as { loosenings: string; confirm?: unknown };
    expect(passed.loosenings).toBe("review");
    expect(passed.confirm).toBe(confirm);
    expect(output.lines.join("\n")).not.toContain("held, not applied");
  });
});
