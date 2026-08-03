// @vitest-environment jsdom
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Finding } from "@vendoai/apps";
import { listRuns, loadRun, saveRun, setPin } from "../runner/store";
import type { LaneName, RunRecord } from "../runner/types";
import type { PaneComponent } from "./pane-props";
import { Cockpit } from "./Cockpit";
import { GenericPane } from "./GenericPane";

/** Boot smoke test: the cockpit renders rail entries and panes from a canned
 *  runs dir, served through a fetch mock that calls the real store. */

const PANES: Record<LaneName, PaneComponent> = {
  vendo: GenericPane,
  "thesys-c1": GenericPane,
  copilotkit: GenericPane,
  tambo: GenericPane,
};

const VENDO_FINDINGS: Finding[] = [
  { severity: "warn", where: 'node "n3" prop "limit"', message: "budget.limit bound to string, expected number" },
];

let runsDir: string;

function cannedRuns(): { current: RunRecord; pinned: RunRecord } {
  const current: RunRecord = {
    id: "20260726-140000-aaaa",
    createdAt: "2026-07-26T14:00:00.000Z",
    gitSha: "96cadbbe000000000000000000000000000000aa",
    gitDirty: "d1",
    request: {
      prompt: "spending by category with budgets",
      host: "maple",
      lanes: ["vendo", "thesys-c1", "copilotkit", "tambo"],
    },
    lanes: {
      vendo: {
        status: "ok",
        startedAt: 1,
        durationMs: 18400,
        costUsd: 0.09,
        document: { app: "spending" } as never,
        wire: "<App><Chart /></App>",
        findings: VENDO_FINDINGS,
      },
      "thesys-c1": { status: "ok", startedAt: 1, durationMs: 11200, raw: { text: "c1 answer" } },
      copilotkit: { status: "failed", startedAt: 1, durationMs: 8900, error: "registry rejected the ask" },
      tambo: { status: "no-key" },
    },
  };
  const pinned: RunRecord = {
    id: "20260726-130000-bbbb",
    createdAt: "2026-07-26T13:00:00.000Z",
    gitSha: "96cadbbe000000000000000000000000000000aa",
    gitDirty: null,
    pin: "baseline",
    request: { prompt: "dispute this charge from Uber", host: "maple", lanes: ["vendo"] },
    lanes: {
      vendo: {
        status: "ok",
        startedAt: 1,
        durationMs: 19200,
        document: { app: "dispute" } as never,
        wire: "<App><Dispute /></App>",
        findings: [],
      },
    },
  };
  return { current, pinned };
}

type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
const jsonRes = (data: unknown): MockResponse => ({
  ok: true,
  status: 200,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

beforeAll(() => {
  runsDir = mkdtempSync(join(tmpdir(), "genui-bench-cockpit-"));
  const { current, pinned } = cannedRuns();
  saveRun(runsDir, pinned);
  saveRun(runsDir, current);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<MockResponse> => {
      const path = String(input).split("?")[0];
      if (path === "/api/runs") return jsonRes({ runs: listRuns(runsDir) });
      const one = /^\/api\/runs\/(.+)$/.exec(path);
      if (one) return jsonRes(loadRun(runsDir, one[1]));
      if (path === "/api/git-state") return jsonRes({ sha: "96cadbbe1234", dirtyFiles: [] });
      if (path === "/api/packs" && init?.method !== "POST") {
        return jsonRes({ packs: [{ name: "smoke", prompts: ["show my account balances at a glance"] }] });
      }
      if (path === "/api/pin") {
        const body = JSON.parse(String(init?.body)) as { id: string; pin?: string | null };
        return jsonRes(setPin(runsDir, body.id, body.pin ?? undefined));
      }
      throw new Error(`unmocked fetch: ${path}`);
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(runsDir, { recursive: true, force: true });
});

afterEach(cleanup);

test("boot: rail lists canned runs, panes render placeholders until a run loads", async () => {
  render(<Cockpit panes={PANES} />);

  // Rail entries from the canned runs dir (newest-first), pin surfaced.
  await screen.findByText("spending by category with budgets");
  screen.getByText(/dispute this charge from Uber/);
  expect(screen.getByText(/★ baseline/)).toBeTruthy();

  // Four panes, all placeholders (nothing selected yet).
  for (const name of ["Vendo", "Thesys C1", "CopilotKit", "Tambo"]) {
    expect(screen.getByRole("region", { name })).toBeTruthy();
  }
  expect(screen.getAllByText("no run loaded")).toHaveLength(4);
  screen.getByText("run something to see the pipeline internals");
});

test("selecting a rail run loads its lane results into the panes", async () => {
  render(<Cockpit panes={PANES} />);
  fireEvent.click(await screen.findByText("spending by category with budgets"));

  // Vendo header: duration + finding count from the checking layer.
  await screen.findByText("18.4s · 1 finding");
  // Failed lane shows its error; keyless lane says so.
  screen.getByText("registry rejected the ask");
  screen.getByText(/no key for this lane/);
  // GenericPane exposes the collapsible document JSON section.
  expect(screen.getAllByText("document JSON").length).toBeGreaterThan(0);
});

test("pinned runs sort first in the rail", async () => {
  const { container } = render(<Cockpit panes={PANES} />);
  await screen.findByText("spending by category with budgets");

  const prompts = [...container.querySelectorAll(".run-item .rprompt")].map(
    (node) => node.textContent ?? "",
  );
  // The pinned run is OLDER than the unpinned one but sorts first.
  expect(prompts[0]).toContain("★ baseline");
  expect(prompts[0]).toContain("dispute this charge from Uber");
  expect(prompts[1]).toContain("spending by category with budgets");
});

test("⌥-click split-compares: panes render both documents, drawer stacks both timelines", async () => {
  render(<Cockpit panes={PANES} />);
  fireEvent.click(await screen.findByText("spending by category with budgets"));
  await screen.findByText("18.4s · 1 finding");

  fireEvent.click(screen.getByText(/dispute this charge from Uber/), { altKey: true });

  // The Vendo pane splits into labeled current/compare halves (read-only).
  await screen.findByText("current");
  screen.getByText("compare");
  // The drawer aligns both runs' findings.
  screen.getByText("current · 20260726-140000-aaaa");
  screen.getByText("compare · 20260726-130000-bbbb");
});

test("pin toggle hits /api/pin and re-sorts the rail", async () => {
  vi.spyOn(window, "prompt").mockReturnValue("gold");
  const { container } = render(<Cockpit panes={PANES} />);
  await screen.findByText("spending by category with budgets");

  fireEvent.click(screen.getByRole("button", { name: "Pin 20260726-140000-aaaa" }));

  // The newly pinned label shows, and the run keeps first place (both pinned
  // now → newest-first within pins).
  await screen.findByText(/★ gold/);
  const prompts = [...container.querySelectorAll(".run-item .rprompt")].map(
    (node) => node.textContent ?? "",
  );
  expect(prompts[0]).toContain("★ gold");

  // Unpin restores the label-less row (round-trip through the real store).
  fireEvent.click(screen.getByRole("button", { name: "Unpin 20260726-140000-aaaa" }));
  await waitFor(() => expect(screen.queryByText(/★ gold/)).toBeNull());
});
