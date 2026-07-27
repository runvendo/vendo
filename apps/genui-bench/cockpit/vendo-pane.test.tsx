// @vitest-environment jsdom
/**
 * Interactive Vendo pane (Task 5): a canned AppDocument renders through the
 * PRODUCTION @vendoai/ui renderer (Kit registry included), its query fires a
 * POST to /api/tools and the returned canned data appears, and clicking a
 * Kit Button fires the bound action tool call. Split-compare renders both
 * documents read-only (actions blocked, no tool POST).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT, type AppDocument, type ToolOutcome } from "@vendoai/core";
import { VendoPane } from "./VendoPane";
import type { HostFixture } from "../runner/types";
import type { LaneResult } from "../runner/types";

const host: HostFixture = {
  name: "maple",
  catalog: [],
  tools: [],
  shapes: {},
  theme: { colors: { accent: "#111111" } },
  execute: async () => ({}),
};

const document_: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_bench_test",
  name: "Profile card",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["owner", "pay"] },
      { id: "owner", component: "Stat", props: { label: "Owner", value: { $path: "/profile/name" } } },
      {
        id: "pay",
        component: "Button",
        props: {
          label: "Send $5",
          onClick: { $action: "host_transferMoney", payload: { amount: 500, recipient_name: "Alex Rivera" } },
        },
      },
    ],
    queries: [{ name: "profile", tool: "host_getProfile" }],
  },
};

const okResult: LaneResult = {
  status: "ok",
  startedAt: 1,
  durationMs: 2,
  document: document_,
  events: [],
};

interface RecordedCall {
  url: string;
  body: { host: string; tool: string; input?: Record<string, unknown> };
}

let calls: RecordedCall[] = [];

const outcomeFor = (tool: string): ToolOutcome =>
  tool === "host_getProfile"
    ? { status: "ok", output: { name: "Avery Chen", email: "avery@maple.demo" } }
    : { status: "ok", output: { id: "txn_transfer_500" } };

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as RecordedCall["body"];
    calls.push({ url: String(url), body });
    return { ok: true, json: async () => outcomeFor(body.tool) };
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VendoPane", () => {
  it("renders through the production renderer, resolves the query via /api/tools, and shows the data", async () => {
    const { container } = render(<VendoPane lane="vendo" result={okResult} host={host} />);

    // (a) the production registry resolved the component (prewired-first
    // order, W3: the branded Stat implementation owns the name).
    expect(container.querySelector('[data-kit="Stat"], [data-primitive="Stat"]')).not.toBeNull();

    // (b) the query POSTed {host, tool, input} to /api/tools …
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/tools" && call.body.tool === "host_getProfile")).toBe(true);
    });
    const query = calls.find((call) => call.body.tool === "host_getProfile") as RecordedCall;
    expect(query.body.host).toBe("maple");

    // … and the returned canned data rendered.
    await waitFor(() => {
      expect(screen.getByText("Avery Chen")).toBeTruthy();
    });
  });

  it("fires the bound tool call when the action button is clicked", async () => {
    render(<VendoPane lane="vendo" result={okResult} host={host} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Send $5" }));

    await waitFor(() => {
      const action = calls.find((call) => call.body.tool === "host_transferMoney");
      expect(action).toBeDefined();
      expect(action?.body.input).toEqual({ amount: 500, recipient_name: "Alex Rivera" });
      expect(action?.body.host).toBe("maple");
    });
  });

  it("split-compare renders both documents read-only", async () => {
    const compare: LaneResult = { ...okResult, document: { ...document_, id: "app_bench_other" } };
    const { container } = render(
      <VendoPane lane="vendo" result={okResult} host={host} compareWith={compare} />,
    );
    expect(container.querySelectorAll('[data-kit="Stat"], [data-primitive="Stat"]').length).toBe(2);

    const before = calls.filter((call) => call.body.tool === "host_transferMoney").length;
    for (const button of screen.getAllByRole("button", { name: "Send $5" })) {
      fireEvent.click(button);
    }
    // Read-only: no action POST leaves the pane.
    await waitFor(() => expect(calls.filter((c) => c.body.tool === "host_getProfile").length).toBeGreaterThan(0));
    expect(calls.filter((call) => call.body.tool === "host_transferMoney").length).toBe(before);
  });

  it("renders the host's own registry components instead of the Unknown-component notice", async () => {
    const hostDoc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_bench_host",
      name: "Net worth",
      ui: "tree",
      tree: {
        formatVersion: VENDO_TREE_FORMAT,
        root: "root",
        nodes: [
          { id: "root", component: "Stack", children: ["card"] },
          {
            id: "card",
            component: "MapleNetWorthCard",
            source: "host",
            props: { valueCents: 5_490_715, series: [5_329_117, 5_490_715], changeLabel: "▲ 2.3% this month" },
          },
        ],
      },
    };
    render(
      <VendoPane lane="vendo" result={{ ...okResult, document: hostDoc }} host={host} />,
    );
    await waitFor(() => expect(screen.queryByText(/Unknown component/)).toBeNull());
    // NetWorthView's own markup: the range switcher it renders for the series.
    expect(screen.getByText("1W")).toBeTruthy();
  });

  it("resolves the Cadence registry for the cadence host", async () => {
    const cadenceDoc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_bench_cadence",
      name: "Doc status",
      ui: "tree",
      tree: {
        formatVersion: VENDO_TREE_FORMAT,
        root: "root",
        nodes: [
          { id: "root", component: "Stack", children: ["badge"] },
          { id: "badge", component: "CadenceStatusBadge", source: "host", props: { text: "Needs review", variant: "review" } },
        ],
      },
    };
    render(
      <VendoPane
        lane="vendo"
        result={{ ...okResult, document: cadenceDoc }}
        host={{ ...host, name: "cadence" }}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/Unknown component/)).toBeNull());
    expect(screen.getByText("Needs review")).toBeTruthy();
  });

  it("shows the failure vocabulary for a failed lane result", () => {
    render(
      <VendoPane
        lane="vendo"
        result={{ status: "failed", startedAt: 1, durationMs: 2, error: "model exploded" }}
        host={host}
      />,
    );
    expect(screen.getByText(/model exploded/)).toBeTruthy();
  });
});
