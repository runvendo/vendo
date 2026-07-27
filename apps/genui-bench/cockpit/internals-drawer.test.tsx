// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PipelineEvent } from "@vendoai/apps";
import type { RunRecord } from "../runner/types";
import { InternalsDrawer } from "./InternalsDrawer";

afterEach(cleanup);

/** A guardrail-style event with a stage the timeline doesn't know yet —
 *  must render its tag + full payload, never disappear. */
const GUARDRAIL_EVENT = {
  stage: "guardrail",
  verdict: "shape-check",
  detail: "budget.limit bound to string, expected number",
} as unknown as PipelineEvent;

const EVENTS: PipelineEvent[] = [
  { stage: "full", attempt: 1, valid: false, ms: 6200 },
  GUARDRAIL_EVENT,
  { stage: "repair", rounds: 1, repaired: true, noValidFix: 0, ms: 2900 },
  { stage: "island-repair", islands: 2, repaired: false, ms: 1400 },
];

function record(id: string, overrides?: Partial<RunRecord>): RunRecord {
  return {
    id,
    createdAt: "2026-07-26T14:00:00.000Z",
    gitSha: "96cadbbe000000000000000000000000000000aa",
    gitDirty: null,
    request: { prompt: "spending by category", host: "maple", lanes: ["vendo", "thesys-c1"] },
    lanes: {
      vendo: {
        status: "ok",
        startedAt: 1,
        durationMs: 18400,
        document: { app: id } as never,
        wire: `<App id="${id}" />`,
        events: EVENTS,
      },
      "thesys-c1": { status: "ok", startedAt: 1, durationMs: 11200, raw: { c1: `answer-${id}` } },
    },
    ...overrides,
  };
}

test("timeline: repair and guardrail events render with payloads, colored by tag", () => {
  render(<InternalsDrawer record={record("run-a")} />);

  const repairTag = screen.getByText("repair");
  expect(repairTag.className).toBe("tag ok");
  screen.getByText("1 round · repaired");

  // Unknown stage → raw payload fallback.
  const guardrailTag = screen.getByText("guardrail");
  expect(guardrailTag.className).toBe("tag info");
  screen.getByText(/budget\.limit bound to string, expected number/);

  // Failed repair reads as an error tone.
  expect(screen.getByText("island-repair").className).toBe("tag err");
  // Invalid full-lane attempt is a warning tone.
  expect(screen.getByText("full").className).toBe("tag warn");
});

test("tabs: wire text, document JSON, per-competitor raw", () => {
  render(<InternalsDrawer record={record("run-a")} />);

  fireEvent.click(screen.getByText("Wire"));
  screen.getByText('<App id="run-a" />');

  fireEvent.click(screen.getByText("Document"));
  screen.getByText(/"app": "run-a"/);

  fireEvent.click(screen.getByText("C1 raw"));
  screen.getByText(/"c1": "answer-run-a"/);
});

test("split-compare stacks both runs' timelines", () => {
  render(<InternalsDrawer record={record("run-a")} compare={record("run-b")} />);

  screen.getByText("current · run-a");
  screen.getByText("compare · run-b");
  expect(screen.getAllByText("repair")).toHaveLength(2);

  // Tabs stack too.
  fireEvent.click(screen.getByText("Wire"));
  screen.getByText('<App id="run-a" />');
  screen.getByText('<App id="run-b" />');
});

/** A failed run must show WHY at a glance — the gap found live 2026-07-26:
 *  the cockpit said only "model could not produce a valid app" while the
 *  engine knew the exact validation issues. */
test("timeline: a failing stage renders its validation issues under the attempt", () => {
  const issues = [
    'tree root "root" renders an empty layout; keep at least one attached, visible node',
    "the app has a title and no content",
  ];
  const failed = record("run-fail", {
    lanes: {
      vendo: {
        status: "failed",
        startedAt: 1,
        durationMs: 24691,
        error: `model could not produce a valid app: ${issues.join(" | ")}`,
        events: [
          { stage: "full", attempt: 0, valid: false, ms: 6984, issues },
          { stage: "repair", rounds: 2, repaired: false, noValidFix: 1, ms: 3100, issues: [issues[1]!] },
        ] as PipelineEvent[],
      },
    },
  });

  const { container } = render(<InternalsDrawer record={failed} />);

  // Each issue reads under its own attempt, not buried in a JSON blob.
  expect(container.querySelectorAll(".ev-issue")).toHaveLength(3);
  expect(screen.getAllByText(issues[0]!)).toHaveLength(1);
  expect(screen.getAllByText(issues[1]!)).toHaveLength(2);

  // The attempt line counts them; the failure line still carries the reason.
  screen.getByText("full-lane attempt 0 · invalid · 2 issues");
  screen.getByText(`model could not produce a valid app: ${issues.join(" | ")}`);
});

test("timeline: a valid attempt renders no issue rows", () => {
  const { container } = render(<InternalsDrawer record={record("run-ok")} />);
  expect(container.querySelectorAll(".ev-issue")).toHaveLength(0);
});
