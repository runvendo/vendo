// @vitest-environment jsdom
/**
 * Pane contract: OpenUIPane renders each LaneResult status, feeding the
 * lane's openui-lang program into their real Renderer with a toolProvider
 * over the bench's /api/tools transport, and always carries its asymmetry
 * footnote.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenUIPane from "./OpenUIPane";
import type { OpenUIRaw } from "../../lanes/openui";
import type { LaneResult } from "../../runner/types";

const MODEL = "claude-sonnet-4-6";

const PROGRAM = [
  'clients = Query("host_listClients", {}, [])',
  'tbl = Table([Col("Business", clients.businessName)])',
  'root = Stack([CardHeader("Client Roster"), tbl])',
].join("\n");

const raw: OpenUIRaw = {
  model: MODEL,
  responseText: PROGRAM,
  program: PROGRAM,
  toolsReferenced: ["host_listClients"],
  toolsUnknown: [],
  parseMeta: { statementCount: 3, unresolved: [], orphaned: [] },
};

const okResult: LaneResult = { status: "ok", startedAt: 0, durationMs: 900, findings: [], raw };

describe("OpenUIPane", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver; their Table measures itself with one.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("/api/tools");
        const body = JSON.parse(String(init?.body)) as { host: string; tool: string };
        expect(body).toMatchObject({ host: "cadence", tool: "host_listClients" });
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", output: [{ businessName: "Rivera Design Co" }] }),
        };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the program through their Renderer, resolving Query() via /api/tools", async () => {
    const { container } = render(<OpenUIPane lane="openui" result={okResult} host="cadence" runId="run_test" />);
    expect(container.querySelector('[data-pane="openui"]')).toBeTruthy();
    // Their runtime parsed the program: the generated header text is on screen.
    await screen.findByText("Client Roster");
    // The Query resolved through the bench transport into rendered data.
    await waitFor(() => expect(screen.getByText("Rivera Design Co")).toBeTruthy());
    // The footnote names the paradigm and the model that produced the pane.
    expect(screen.getByText(new RegExp(`openui-lang · their runtime.*${MODEL}`))).toBeTruthy();
  });

  it("renders the no-key state", () => {
    render(<OpenUIPane lane="openui" result={{ status: "no-key" }} host="cadence" runId="run_test" />);
    expect(screen.getByText(/no key/)).toBeTruthy();
  });

  it("renders the failed state with the error", () => {
    render(
      <OpenUIPane
        lane="openui"
        result={{ status: "failed", startedAt: 0, durationMs: 10, error: "their parser rejected the program" }}
        host="cadence"
        runId="run_test"
      />,
    );
    expect(screen.getByText(/failed: their parser rejected the program/)).toBeTruthy();
  });
});
