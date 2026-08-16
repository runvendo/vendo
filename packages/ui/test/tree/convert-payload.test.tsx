// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  VENDO_TREE_FORMAT,
  type Json,
  type ToolOutcome,
  type UIPayload,
} from "@vendoai/core";
import { type Tree } from "@vendoai/apps/contract";
import { PayloadView, TreeView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** Only the server's hash-pin verdict unlocks the in-client mount. */
const GRANTED = {
  granted: true as const,
  versionHash: "sha256:approved",
  approvedBy: "host-console",
  at: "2026-07-15T09:00:00.000Z",
};

function treePayload(
  nodes: Tree["nodes"],
  extras: Partial<Omit<Tree, "formatVersion" | "nodes">> & { components?: Record<string, string> } = {},
): UIPayload {
  return {
    formatVersion: VENDO_TREE_FORMAT,
    root: extras.root ?? nodes[0]?.id ?? "root",
    nodes,
    ...extras,
  } as unknown as UIPayload;
}

describe("vendo-genui/v2 renderer registration", () => {
  it("dispatches a tree payload by its format tag instead of the unsupported-format notice", () => {
    render(
      <PayloadView
        payload={treePayload([
          { id: "root", component: "Stack", children: ["text-1"] },
          { id: "text-1", component: "Text", props: { text: "v2 says hello" } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByText("v2 says hello")).toBeTruthy();
    expect(screen.queryByRole("note", { name: /unsupported ui format/i })).toBeNull();
  });

  it("renders the built-in Kit components from a v2 tree", () => {
    render(
      <PayloadView
        payload={treePayload([
          { id: "root", component: "Stack", children: ["heading", "row", "grid", "surface", "divider"] },
          { id: "heading", component: "Text", props: { text: "v2 heading", variant: "heading" } },
          { id: "row", component: "Row" },
          { id: "grid", component: "Grid", props: { columns: 2 } },
          { id: "surface", component: "Surface" },
          { id: "divider", component: "Divider" },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByText("v2 heading").getAttribute("data-kit")).toBe("Text");
    for (const name of ["Stack", "Row", "Grid", "Surface", "Divider"]) {
      expect(document.querySelector(`[data-kit="${name}"]`)).not.toBeNull();
    }
  });

  it("contains an invalid v2 payload with the validation notice instead of throwing", () => {
    render(
      <PayloadView
        payload={treePayload([{ id: "root", component: "Stack" }], { root: "not-a-node" })}
        components={{}}
        onAction={ok}
      />,
    );

    const notice = screen.getByRole("note", { name: /invalid ui tree/i });
    expect(notice.getAttribute("data-error-code")).toBe("provision");
    expect(notice.textContent).toContain("not-a-node");
  });
});

describe("vendo-genui/v2 bindings and data residency", () => {
  it("resolves $path bindings against data keyed at /<query name>", () => {
    const RevenueLabel: ComponentType<{ total?: unknown; all?: unknown }> = ({ total, all }) => (
      <output data-total={String(total)}>{JSON.stringify(all)}</output>
    );
    const data = { revenue: { total: 42, currency: "USD" } } satisfies Record<string, Json>;

    render(
      <PayloadView
        payload={treePayload(
          [{
            id: "revenuelabel-1",
            component: "RevenueLabel",
            source: "host",
            props: {
              total: { $path: "/revenue/total" },
              all: { $path: "/revenue" },
            },
          }],
          { queries: [{ name: "revenue", tool: "metrics_revenue" }] },
        )}
        components={{ RevenueLabel }}
        data={data}
        onAction={ok}
      />,
    );

    const output = screen.getByRole("status");
    expect(output.getAttribute("data-total")).toBe("42");
    expect(output.textContent).toContain('"currency":"USD"');
  });

  it("updates $state reads from an approved component's state writes", async () => {
    const StateProbe: ComponentType<{ value?: unknown }> = ({ value }) => <output>{String(value)}</output>;
    render(
      <PayloadView
        payload={treePayload(
          [
            { id: "root", component: "Row", children: ["editor-1", "stateprobe-1"] },
            { id: "editor-1", component: "Editor", source: "generated" },
            { id: "stateprobe-1", component: "StateProbe", source: "host", props: { value: { $state: "draft" } } },
          ],
          {
            root: "root",
            components: {
              Editor: `import { useEffect } from "react";
export default function Editor({ vendo }) {
  useEffect(() => { vendo.setState("draft", "saved in v2"); }, []);
  return <div>editor</div>;
}`,
            },
            inClient: GRANTED,
          } as never,
        )}
        components={{ StateProbe }}
        onAction={ok}
      />,
    );

    await waitFor(() => expect(screen.getByText("saved in v2")).toBeTruthy());
  });
});

describe("vendo-genui/v2 actions", () => {
  it("dispatches an {action} prop through onAction with the node's own id", async () => {
    const ActionRow: ComponentType<{ label?: string; onRun?: () => Promise<ToolOutcome> }> = ({ label, onRun }) => (
      <button type="button" onClick={() => void onRun?.()}>{label}</button>
    );
    const onAction = vi.fn(ok);

    render(
      <PayloadView
        payload={treePayload([{
          id: "actionrow-1",
          component: "ActionRow",
          source: "host",
          // The canonical action prop shape a tree carries (`convert-payload.ts`).
          props: { label: "Run", onRun: { action: "fn:submit_report" } },
        }])}
        components={{ ActionRow }}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({
      nodeId: "actionrow-1",
      action: "fn:submit_report",
    }));
  });
});

describe("vendo-genui/v2 component source resolution", () => {
  it("renders the HOST implementation when source is explicitly host, even over a built-in name", () => {
    const Card: ComponentType<{ title?: string }> = ({ title }) => <article>Host card: {title}</article>;
    render(
      <PayloadView
        payload={treePayload([
          { id: "card-1", component: "Card", source: "host", props: { title: "brand wins" } },
        ])}
        components={{ Card }}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Host card: brand wins")).toBeTruthy();
    expect(document.querySelector('[data-kit="Card"]')).toBeNull();
  });

  it("still prefers the built-in for an undefined-source name collision (v1 parity)", () => {
    const Card: ComponentType<{ title?: string }> = ({ title }) => <article>Host card: {title}</article>;
    render(
      <PayloadView
        payload={treePayload([
          { id: "card-1", component: "Card", props: { title: "built-in wins" } },
        ])}
        components={{ Card }}
        onAction={ok}
      />,
    );

    expect(document.querySelector('[data-kit="Card"]')).not.toBeNull();
    expect(screen.queryByText("Host card: built-in wins")).toBeNull();
  });

  it("mounts an APPROVED generated component in the host page with its payload-carried source", async () => {
    render(
      <PayloadView
        payload={treePayload(
          [{ id: "revenuenote-1", component: "RevenueNote", source: "generated" }],
          {
            components: { RevenueNote: "export default function RevenueNote() { return <p>note</p> }" },
            inClient: GRANTED,
          } as never,
        )}
        components={{}}
        onAction={ok}
      />,
    );

    expect(await screen.findByText("note")).toBeTruthy();
    expect(document.querySelector('[data-vendo-inclient-mount="RevenueNote"]')).not.toBeNull();
  });
});

describe("v1 walk regression", () => {
  it("keeps preferring the built-in for undefined-source v1 nodes that collide with host names", () => {
    const Card: ComponentType<{ title?: string }> = ({ title }) => <article>Host card: {title}</article>;
    const v1Tree = {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [{ id: "root", component: "Card", props: { title: "still built-in" } }],
    };
    render(
      <TreeView
        tree={v1Tree}
        components={{ Card }}
        onAction={ok}
      />,
    );

    expect(document.querySelector('[data-kit="Card"]')).not.toBeNull();
    expect(screen.queryByText("Host card: still built-in")).toBeNull();
  });
});

/** v2 spec §3 — runtime reshape containment: a binding's $reshape chain is
 *  applied on resolution; a data-shape mismatch renders the contained
 *  data-shape notice INSTEAD of mounting the component with garbage props;
 *  absent data (query still loading) is not a mismatch. */
describe("v2 reshape bindings at render", () => {
  const revenueData: Record<string, Json> = {
    revenue: { rows: [{ month: "Jan", revenue: 1200 }, { month: "Feb", revenue: 900 }] },
  };

  it("applies a $reshape chain on resolution (count over rows renders 2)", () => {
    render(
      <PayloadView
        payload={treePayload([
          { id: "root", component: "Stack", children: ["text-1"] },
          {
            id: "text-1",
            component: "Text",
            props: { text: { $path: "/revenue/rows", $reshape: [{ op: "count", args: [] }] } },
          },
        ], { data: revenueData })}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.queryByRole("note", { name: "Data shape" })).toBeNull();
  });

  it("renders the contained data-shape notice on a runtime mismatch instead of a broken component", () => {
    render(
      <PayloadView
        payload={treePayload([
          { id: "root", component: "Stack", children: ["text-1"] },
          {
            id: "text-1",
            component: "Text",
            props: {
              text: {
                $path: "/revenue/rows",
                $reshape: [{ op: "asPoints", args: ["period", "value"] }],
              },
            },
          },
        ], { data: revenueData })}
        components={{}}
        onAction={ok}
      />,
    );
    const notice = screen.getByRole("note", { name: "Data shape" });
    expect(notice.textContent).toContain("period");
    expect(document.querySelector('[data-kit="Text"]')).toBeNull();
  });

  it("a mis-bound container's notice replaces the component only, never its valid children", () => {
    render(
      <PayloadView
        payload={treePayload([
          { id: "root", component: "Stack", children: ["card-1"] },
          {
            id: "card-1",
            component: "Card",
            props: { title: { $path: "/revenue/rows", $reshape: [{ op: "asPoints", args: ["period", "value"] }] } },
            children: ["text-1"],
          },
          { id: "text-1", component: "Text", props: { text: "child survives" } },
        ], { data: revenueData })}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.getByRole("note", { name: "Data shape" })).toBeTruthy();
    expect(screen.getByText("child survives")).toBeTruthy();
  });

  it("absent data is loading, not a mismatch: no notice, component renders empty", () => {
    render(
      <PayloadView
        payload={treePayload([
          { id: "root", component: "Stack", children: ["text-1", "text-2"] },
          {
            id: "text-1",
            component: "Text",
            props: { text: { $path: "/pending/rows", $reshape: [{ op: "count", args: [] }] } },
          },
          { id: "text-2", component: "Text", props: { text: "still here" } },
        ], { data: {} })}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.queryByRole("note", { name: "Data shape" })).toBeNull();
    expect(screen.getByText("still here")).toBeTruthy();
  });
});

describe("streaming error recovery", () => {
  it("recovers a node that threw on absent streaming data once the data arrives", () => {
    const Sparkline: ComponentType<{ series?: number[] }> = ({ series }) => (
      <output>{(series as number[]).slice(0, 2).join(",")}</output>
    );
    const payload = (data?: Record<string, Json>): UIPayload => ({
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["sparkline-1"] },
        { id: "sparkline-1", component: "Sparkline", source: "host", props: { series: { $path: "/accounts/spark" } } },
      ],
      ...(data === undefined ? {} : { data }),
    } as unknown as UIPayload);
    const noop = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

    const view = render(
      <PayloadView payload={payload()} components={{ Sparkline }} onAction={noop} />,
    );
    expect(screen.getByRole("note", { name: /node render error/i })).toBeTruthy();

    view.rerender(
      <PayloadView payload={payload({ accounts: { spark: [5, 9, 12] } })} components={{ Sparkline }} onAction={noop} />,
    );
    expect(screen.queryByRole("note", { name: /node render error/i })).toBeNull();
    expect(screen.getByText("5,9")).toBeTruthy();
  });
});
