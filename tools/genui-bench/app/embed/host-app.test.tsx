// @vitest-environment jsdom
/**
 * The embed runtime: a canned AppDocument renders through the PRODUCTION
 * @vendoai/ui renderer (Kit registry + the host's own registry), its query
 * fires a POST to /api/tools and the returned canned data appears, and
 * clicking a Kit Button fires the bound action tool call. Read-only mode
 * (split-compare) still resolves queries but blocks actions.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT, type AppDocument, type ToolOutcome } from "@vendoai/core";
import { HostApp } from "./host-app";
import { stubTheme } from "../../fixtures/stub";

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

describe("HostApp", () => {
  it("renders through the production renderer, resolves the query via /api/tools, and shows the data", async () => {
    const { container } = render(
      <HostApp host="maple" theme={stubTheme} document={document_} readOnly={false} />,
    );

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
    render(<HostApp host="maple" theme={stubTheme} document={document_} readOnly={false} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Send $5" }));

    await waitFor(() => {
      const action = calls.find((call) => call.body.tool === "host_transferMoney");
      expect(action).toBeDefined();
      expect(action?.body.input).toEqual({ amount: 500, recipient_name: "Alex Rivera" });
      expect(action?.body.host).toBe("maple");
    });
  });

  it("read-only mode resolves queries but blocks actions", async () => {
    render(<HostApp host="maple" theme={stubTheme} document={document_} readOnly />);
    await waitFor(() => expect(calls.filter((c) => c.body.tool === "host_getProfile").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Send $5" }));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.filter((call) => call.body.tool === "host_transferMoney").length).toBe(0);
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
    render(<HostApp host="maple" theme={stubTheme} document={hostDoc} readOnly={false} />);
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
    render(<HostApp host="cadence" theme={stubTheme} document={cadenceDoc} readOnly={false} />);
    await waitFor(() => expect(screen.queryByText(/Unknown component/)).toBeNull());
    expect(screen.getByText("Needs review")).toBeTruthy();
  });
});
