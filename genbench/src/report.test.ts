/**
 * What the one page a person actually opens has to get right: a column per
 * contender in a fixed order however the row finished, one section per case, and
 * beside each case the data its screens were graded against — the case's own,
 * overrides applied, or the panel is worse than useless.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { FloorResult } from "./floor.js";
import { writePreview } from "./report.js";
import type { CaseResult } from "./run.js";
import { loadCases, loadWorld, worldForCase, type World } from "./world.js";

const PASSING: FloorResult = {
  delivered: true,
  renders: true,
  valid: true,
  blocking: [],
  honestData: { pass: true, offenders: [] },
  wiredActions: { pass: true, bindings: [] },
  pass: true,
};

const resultFor = (contender: string, testCase: string, prompt: string): CaseResult => ({
  run: "run-1",
  contender,
  model: "claude-sonnet-5",
  case: testCase,
  prompt,
  lane: "screen",
  floor: PASSING,
  timing: { firstRenderMs: 1_000, settledMs: 2_000 },
  cost: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 }, usd: 0.01 },
  islands: 0,
  clientOnly: 0,
  trace: [],
  consoleErrors: [],
  world: "hash",
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let emptyWorld: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "world.json"));
  const cases = await loadCases(join(root, "cases.json"));
  emptyWorld = worldForCase(world, cases.find((entry) => entry.id === "no-pending-transfers")!);
});

/** The page escapes everything it prints — a tool name on it came out of a
 *  model — so an assertion about JSON on the page has to be escaped too. */
const onPage = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const preview = async (results: readonly CaseResult[], worlds: Record<string, World>): Promise<string> => {
  const runDir = await mkdtemp(join(tmpdir(), "genbench-report-"));
  await writeFile(join(runDir, "preview-input.json"), "{}");
  return await readFile(await writePreview({ runDir, runId: "run-1", results, worlds }), "utf8");
};

describe("the preview page", () => {
  it("keeps the column order it was given, whoever finished first", async () => {
    const html = await preview(
      [resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."), resultFor("diy-sonnet", "pending-transfers", "Show my pending transfers.")],
      { "pending-transfers": world },
    );

    expect(html.indexOf("vendo-sonnet")).toBeLessThan(html.indexOf("diy-sonnet"));
  });

  it("gives every case its own section rather than stacking them under one prompt", async () => {
    const html = await preview(
      [
        resultFor("vendo-sonnet", "pending-transfers", "Show my pending transfers."),
        resultFor("diy-sonnet", "pending-transfers", "Show my pending transfers."),
        resultFor("vendo-sonnet", "spend-overview", "Show me where my money went."),
        resultFor("diy-sonnet", "spend-overview", "Show me where my money went."),
      ],
      { "pending-transfers": world, "spend-overview": world },
    );

    expect(html.split(`class="case"`).length - 1).toBe(2);
    expect(html).toContain("Show my pending transfers.");
    expect(html).toContain("Show me where my money went.");
  });

  it("shows the case's own tool data, overrides applied, not the authored world", async () => {
    const html = await preview([resultFor("vendo-sonnet", "no-pending-transfers", "Show my pending transfers.")], {
      "no-pending-transfers": emptyWorld,
    });

    expect(html).toContain("World data");
    expect(html).toContain("cancel_transfer");
    // The empty override is what these screens were graded against…
    expect(html).toContain(onPage({ data: [] }));
    // …so the authored rows must not be sitting beside them as if they were.
    expect(html).not.toContain("Alex Rivera");
    // A write tool answers with its acknowledgement, the same one the page gives.
    expect(html).toContain(onPage({ ok: true }));
  });

  it("carries the listener that turns a press in an embedded page into a feed row", async () => {
    const html = await preview([resultFor("vendo-sonnet", "spend-overview", "Show me where my money went.")], {
      "spend-overview": world,
    });

    expect(html).toContain(`<ol id="feed">`);
    expect(html).toContain(`addEventListener("message"`);
    expect(html).toContain(`call.genbench !== "call"`);
  });
});
