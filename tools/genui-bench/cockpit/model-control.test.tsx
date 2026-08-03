// @vitest-environment jsdom
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listRuns } from "../runner/store";
import { PRODUCTION_MODEL } from "../runner/models";
import type { LaneName, RunRequest } from "../runner/types";
import type { PaneComponent } from "./pane-props";
import { Cockpit } from "./Cockpit";
import { GenericPane } from "./GenericPane";

/** The model control: renders collapsed, drives the POST /api/run body, and
 *  remembers the last choice in localStorage. No model calls — /api/run is
 *  mocked and only its request body is asserted. */

const PANES: Record<LaneName, PaneComponent> = {
  vendo: GenericPane,
  "thesys-c1": GenericPane,
  copilotkit: GenericPane,
  tambo: GenericPane,
};

let runsDir: string;
let runBodies: RunRequest[];

type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
const jsonRes = (data: unknown): MockResponse => ({
  ok: true,
  status: 200,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

beforeAll(() => {
  runsDir = mkdtempSync(join(tmpdir(), "genui-bench-model-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<MockResponse> => {
      const path = String(input).split("?")[0];
      if (path === "/api/runs") return jsonRes({ runs: listRuns(runsDir) });
      if (path === "/api/packs") return jsonRes({ packs: [] });
      if (path === "/api/git-state") return jsonRes({ sha: "abc1234", dirtyFiles: [] });
      if (path === "/api/run") {
        runBodies.push(JSON.parse(String(init?.body)) as RunRequest);
        return jsonRes(null);
      }
      throw new Error(`unmocked fetch: ${path}`);
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(runsDir, { recursive: true, force: true });
});

beforeEach(() => {
  runBodies = [];
  window.localStorage.clear();
});

afterEach(cleanup);

async function openControl() {
  const trigger = await screen.findByRole("button", { name: "Model" });
  fireEvent.click(trigger);
  return trigger;
}

/** The popover's backdrop is what closes it (the packs-menu pattern). */
function closeControl() {
  fireEvent.click(document.querySelector(".menu-backdrop")!);
}

test("collapsed by default, showing the engine default; expands to the model list", async () => {
  render(<Cockpit panes={PANES} />);

  const trigger = await screen.findByRole("button", { name: "Model" });
  expect(trigger.textContent).toContain(PRODUCTION_MODEL.label);
  // Collapsed: the model list is not in the DOM until it is opened.
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(trigger);
  screen.getByRole("menu");
  screen.getByText(/Opus 5/);
  screen.getByText(/Haiku 4.5/);
});

test("run POST carries the chosen model, temperature and thinking", async () => {
  render(<Cockpit panes={PANES} />);
  await openControl();

  // A Claude 5 model: effort chips, no temperature field.
  fireEvent.click(screen.getByText(/Opus 5/));
  expect(screen.queryByLabelText("Temperature")).toBeNull();
  screen.getByText(/takes no temperature/);
  fireEvent.click(screen.getByRole("button", { name: "high" }));
  closeControl();

  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "spending by category" } });
  fireEvent.click(screen.getByRole("button", { name: /Run/ }));

  await waitFor(() => expect(runBodies).toHaveLength(1));
  expect(runBodies[0].model).toEqual({ id: "claude-opus-5", effort: "high" });

  // A budget-dialect model: temperature + a thinking token budget.
  await openControl();
  fireEvent.click(screen.getByText(/Haiku 4.5/));
  fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.7" } });
  fireEvent.change(screen.getByLabelText("Thinking budget"), { target: { value: "4096" } });
  closeControl();
  fireEvent.click(screen.getByRole("button", { name: /Run/ }));

  await waitFor(() => expect(runBodies).toHaveLength(2));
  expect(runBodies[1].model).toEqual({
    id: "claude-haiku-4-5-20251001",
    temperature: 0.7,
    thinkingBudget: 4096,
  });
});

test("no model chosen → no model on the request (the run measures what ships)", async () => {
  render(<Cockpit panes={PANES} />);
  fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "hi" } });
  fireEvent.click(screen.getByRole("button", { name: /Run/ }));

  await waitFor(() => expect(runBodies).toHaveLength(1));
  expect(runBodies[0].model).toBeUndefined();
});

test("remembers the last choice across a remount, and clearing it forgets", async () => {
  const first = render(<Cockpit panes={PANES} />);
  await openControl();
  fireEvent.click(screen.getByText(/Sonnet 5/));
  expect(JSON.parse(window.localStorage.getItem("genui-bench:model")!)).toEqual({
    id: "claude-sonnet-5",
  });
  first.unmount();

  render(<Cockpit panes={PANES} />);
  const trigger = await screen.findByRole("button", { name: "Model" });
  expect(trigger.textContent).toContain("Sonnet 5");

  fireEvent.click(trigger);
  fireEvent.click(screen.getByText(/Default —/));
  expect(window.localStorage.getItem("genui-bench:model")).toBeNull();
  expect((await screen.findByRole("button", { name: "Model" })).textContent).toContain(
    PRODUCTION_MODEL.label,
  );
});
