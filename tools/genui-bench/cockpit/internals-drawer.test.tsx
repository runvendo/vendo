// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Finding } from "@vendoai/apps";
import type { RunRecord } from "../runner/types";
import { InternalsDrawer } from "./InternalsDrawer";

afterEach(cleanup);

const FINDINGS: Finding[] = [
  { severity: "warn", where: 'node "n3" prop "limit"', message: "budget.limit bound to string, expected number" },
  { severity: "block", where: "document", message: "the app has a title and no content" },
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
        findings: FINDINGS,
      },
      "thesys-c1": { status: "ok", startedAt: 1, durationMs: 11200, raw: { c1: `answer-${id}` } },
    },
    ...overrides,
  };
}

test("findings render severity, where and message, colored by severity", () => {
  render(<InternalsDrawer record={record("run-a")} />);

  expect(screen.getByText("warn").className).toBe("tag warn");
  expect(screen.getByText("block").className).toBe("tag err");
  screen.getByText(/budget\.limit bound to string, expected number/);
  screen.getByText(/the app has a title and no content/);
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

test("split-compare stacks both runs' findings", () => {
  render(<InternalsDrawer record={record("run-a")} compare={record("run-b")} />);

  screen.getByText("current · run-a");
  screen.getByText("compare · run-b");
  expect(screen.getAllByText("block")).toHaveLength(2);

  // Tabs stack too.
  fireEvent.click(screen.getByText("Wire"));
  screen.getByText('<App id="run-a" />');
  screen.getByText('<App id="run-b" />');
});

/** A failed run must show WHY at a glance — the reason (refusal sentences or
 *  generation issues) rides the lane error. */
test("a failed lane renders its reason", () => {
  const failed = record("run-fail", {
    lanes: {
      vendo: {
        status: "failed",
        startedAt: 1,
        durationMs: 24691,
        error: "the host refused this ask: Maple cannot move money to an account it does not hold.",
      },
    },
  });

  render(<InternalsDrawer record={failed} />);

  expect(screen.getByText("failed").className).toBe("tag err");
  screen.getByText(/Maple cannot move money to an account it does not hold\./);
});

test("an app with no findings shows the empty state", () => {
  const clean = record("run-clean", {
    lanes: { vendo: { status: "ok", startedAt: 1, durationMs: 18400, findings: [] } },
  });
  render(<InternalsDrawer record={clean} />);
  screen.getByText("(nothing found on this app)");
});
