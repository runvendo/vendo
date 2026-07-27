// @vitest-environment jsdom
/**
 * Pane contract: the Vendo pane frames the run in its host's document
 * (/embed/<host>?run=<id>) rather than rendering it in the cockpit's own
 * document — that frame boundary is what gives the app the host's brand theme
 * and Tailwind while keeping host CSS off the cockpit chrome. The runtime
 * inside the frame is covered by app/embed/host-app.test.tsx.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT, type AppDocument } from "@vendoai/core";
import { VendoPane } from "./VendoPane";
import type { LaneResult } from "../runner/types";

const document_: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_bench_test",
  name: "Profile card",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [{ id: "root", component: "Stack", children: [] }],
  },
};

const okResult: LaneResult = { status: "ok", startedAt: 1, durationMs: 2, document: document_, events: [] };

const frames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("iframe")).map((frame) => frame.getAttribute("src"));

afterEach(cleanup);

describe("VendoPane", () => {
  it("frames the run in its host's own document", () => {
    const { container } = render(
      <VendoPane lane="vendo" result={okResult} runId="20260726-1200-abcd" host="maple" />,
    );
    expect(frames(container)).toEqual(["/embed/maple?run=20260726-1200-abcd"]);
  });

  it("frames the cadence host's document for a cadence run", () => {
    const { container } = render(
      <VendoPane lane="vendo" result={okResult} runId="run_cadence" host="cadence" />,
    );
    expect(frames(container)).toEqual(["/embed/cadence?run=run_cadence"]);
  });

  it("split-compare frames both runs read-only", () => {
    const { container } = render(
      <VendoPane
        lane="vendo"
        result={okResult}
        runId="run_a"
        host="maple"
        compare={{ result: okResult, runId: "run_b" }}
      />,
    );
    expect(frames(container)).toEqual([
      "/embed/maple?run=run_a&mode=readonly",
      "/embed/maple?run=run_b&mode=readonly",
    ]);
  });

  it("shows the failure vocabulary for a failed lane result, with no frame", () => {
    const { container } = render(
      <VendoPane
        lane="vendo"
        result={{ status: "failed", startedAt: 1, durationMs: 2, error: "model exploded" }}
        runId="run_failed"
        host="maple"
      />,
    );
    expect(screen.getByText(/model exploded/)).toBeTruthy();
    expect(frames(container)).toEqual([]);
  });

  it("shows the no-key state", () => {
    render(<VendoPane lane="vendo" result={{ status: "no-key" }} runId="run_nokey" host="maple" />);
    expect(screen.getByText(/No model key/)).toBeTruthy();
  });
});
