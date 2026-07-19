// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  compileWireV2,
  VENDO_TREE_FORMAT_V2,
  type Json,
  type ToolOutcome,
  type TreeV2,
  type UIPayload,
} from "@vendoai/core";
import { PayloadView, TreeView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

function treeV2(
  nodes: TreeV2["nodes"],
  extras: Partial<Omit<TreeV2, "formatVersion" | "nodes">> & { components?: Record<string, string> } = {},
): UIPayload {
  return {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: extras.root ?? nodes[0]?.id ?? "root",
    nodes,
    ...extras,
  } as unknown as UIPayload;
}

describe("vendo-genui/v2 renderer registration", () => {
  it("dispatches a v2 payload by tag instead of the unsupported-format notice", () => {
    render(
      <PayloadView
        payload={treeV2([
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

  it("renders the prewired primitives from a v2 tree", () => {
    render(
      <PayloadView
        payload={treeV2([
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

    expect(screen.getByText("v2 heading").getAttribute("data-primitive")).toBe("Text");
    for (const name of ["Stack", "Row", "Grid", "Surface", "Divider"]) {
      expect(document.querySelector(`[data-primitive="${name}"]`)).not.toBeNull();
    }
  });

  it("contains an invalid v2 payload with the validation notice instead of throwing", () => {
    render(
      <PayloadView
        payload={treeV2([{ id: "root", component: "Stack" }], { root: "not-a-node" })}
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
        payload={treeV2(
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

  it("updates $state reads from jail state-set messages", async () => {
    const StateProbe: ComponentType<{ value?: unknown }> = ({ value }) => <output>{String(value)}</output>;
    render(
      <PayloadView
        payload={treeV2(
          [
            { id: "root", component: "Row", children: ["editor-1", "stateprobe-1"] },
            { id: "editor-1", component: "Editor", source: "generated" },
            { id: "stateprobe-1", component: "StateProbe", source: "host", props: { value: { $state: "draft" } } },
          ],
          { root: "root", components: { Editor: "export default function Editor() { return <div>editor</div> }" } },
        )}
        components={{ StateProbe }}
        onAction={ok}
      />,
    );

    // The generated island mounts in the jail iframe, not the host page.
    const iframe = screen.getByTitle("Generated component: Editor") as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "state-set", key: "draft", value: "saved in v2" },
    }));

    await waitFor(() => expect(screen.getByText("saved in v2")).toBeTruthy());
  });
});

describe("vendo-genui/v2 actions", () => {
  it("dispatches compiler-emitted {action} props through onAction with the minted node id", async () => {
    const wire = '<App name="Actions"><ActionRow label="Run" onRun="fn:submit_report"/></App>';
    const compiled = compileWireV2(wire, { hostComponents: ["ActionRow"] });
    expect(compiled.complete).toBe(true);
    expect(compiled.issues).toEqual([]);

    const ActionRow: ComponentType<{ label?: string; onRun?: () => Promise<ToolOutcome> }> = ({ label, onRun }) => (
      <button type="button" onClick={() => void onRun?.()}>{label}</button>
    );
    const onAction = vi.fn(ok);

    render(
      <PayloadView
        payload={compiled.tree as unknown as UIPayload}
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
  it("renders the HOST implementation when source is explicitly host, even over a prewired name", () => {
    const Card: ComponentType<{ title?: string }> = ({ title }) => <article>Host card: {title}</article>;
    render(
      <PayloadView
        payload={treeV2([
          { id: "card-1", component: "Card", source: "host", props: { title: "brand wins" } },
        ])}
        components={{ Card }}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Host card: brand wins")).toBeTruthy();
    expect(document.querySelector('[data-primitive="Card"]')).toBeNull();
  });

  it("still prefers the primitive for an undefined-source name collision (v1 parity)", () => {
    const Card: ComponentType<{ title?: string }> = ({ title }) => <article>Host card: {title}</article>;
    render(
      <PayloadView
        payload={treeV2([
          { id: "card-1", component: "Card", props: { title: "primitive wins" } },
        ])}
        components={{ Card }}
        onAction={ok}
      />,
    );

    expect(document.querySelector('[data-primitive="Card"]')).not.toBeNull();
    expect(screen.queryByText("Host card: primitive wins")).toBeNull();
  });

  it("mounts a generated island in the jail with its payload-carried source", () => {
    render(
      <PayloadView
        payload={treeV2(
          [{ id: "revenuenote-1", component: "RevenueNote", source: "generated" }],
          { components: { RevenueNote: "export default function RevenueNote() { return <p>note</p> }" } },
        )}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByTitle("Generated component: RevenueNote")).toBeTruthy();
  });
});

describe("v1 walk regression", () => {
  it("keeps preferring the primitive for undefined-source v1 nodes that collide with host names", () => {
    const Card: ComponentType<{ title?: string }> = ({ title }) => <article>Host card: {title}</article>;
    render(
      <TreeView
        tree={{
          formatVersion: "vendo-genui/v2",
          root: "root",
          nodes: [{ id: "root", component: "Card", props: { title: "still primitive" } }],
        }}
        components={{ Card }}
        onAction={ok}
      />,
    );

    expect(document.querySelector('[data-primitive="Card"]')).not.toBeNull();
    expect(screen.queryByText("Host card: still primitive")).toBeNull();
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
        payload={treeV2([
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
        payload={treeV2([
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
    expect(document.querySelector('[data-primitive="Text"]')).toBeNull();
  });

  it("a mis-bound container's notice replaces the component only, never its valid children", () => {
    render(
      <PayloadView
        payload={treeV2([
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
        payload={treeV2([
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
      formatVersion: VENDO_TREE_FORMAT_V2,
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
