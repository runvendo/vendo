// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VENDO_TREE_FORMAT_V2, type Json, type ToolOutcome } from "@vendoai/core";
import { PayloadView, TreeView, registerTreeRenderer, type WalkTree } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

function tree(nodes: WalkTree["nodes"], root = nodes[0]?.id ?? "root", components?: Record<string, string>): WalkTree {
  return { formatVersion: VENDO_TREE_FORMAT_V2, root, nodes, components };
}

describe("TreeView public surface", () => {
  it("renders the reserved primitives", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["heading", "row", "grid", "surface", "divider", "skeleton"] },
          { id: "heading", component: "Text", props: { text: "Tree heading", variant: "heading" } },
          { id: "row", component: "Row" },
          { id: "grid", component: "Grid", props: { columns: 3 } },
          { id: "surface", component: "Surface" },
          { id: "divider", component: "Divider" },
          { id: "skeleton", component: "Skeleton" },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Tree heading").getAttribute("data-primitive")).toBe("Text");
    for (const name of ["Stack", "Row", "Grid", "Surface", "Divider", "Skeleton"]) {
      expect(document.querySelector(`[data-primitive="${name}"]`)).not.toBeNull();
    }
  });

  it("looks up host components and contains unknown names", () => {
    const HostCard: ComponentType<{ label?: string }> = ({ label }) => <article>Host: {label}</article>;
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["known", "missing"] },
          { id: "known", component: "HostCard", source: "host", props: { label: "ready" } },
          { id: "missing", component: "HallucinatedCard", source: "host" },
        ])}
        components={{ HostCard }}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Host: ready")).toBeTruthy();
    expect(screen.getByRole("note", { name: /unknown component/i }).textContent).toContain("HallucinatedCard");
  });

  it("renders dangling children as streaming skeletons", () => {
    render(
      <TreeView
        tree={tree([{ id: "root", component: "Stack", children: ["not-yet-streamed"] }])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(document.querySelector('[data-dangling-node="not-yet-streamed"] [data-primitive="Skeleton"]')).not.toBeNull();
  });

  it("skeletons a generated node until its streamed source arrives", () => {
    const partial = {
      ...tree([{ id: "root", component: "RevenueCard", source: "generated" }]),
      streaming: true,
    } as WalkTree;

    render(<TreeView tree={partial} components={{}} onAction={ok} />);

    expect(document.querySelector('[data-streaming-component="RevenueCard"] [data-primitive="Skeleton"]')).not.toBeNull();
    expect(screen.queryByRole("note", { name: /invalid ui tree/i })).toBeNull();
  });

  it("contains a validated but empty rooted layout instead of rendering a blank surface", () => {
    render(
      <TreeView
        tree={tree([{ id: "root", component: "Stack", source: "prewired" }])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByRole("note", { name: /empty ui tree/i }).textContent).toMatch(/no renderable content/i);
  });

  it("contains an erroring host node while preserving its sibling", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error("host render exploded");
    };
    const Fine = () => <p>Sibling survived</p>;

    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Row", children: ["bad", "fine"] },
          { id: "bad", component: "Boom", source: "host" },
          { id: "fine", component: "Fine", source: "host" },
        ])}
        components={{ Boom, Fine }}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Sibling survived")).toBeTruthy();
    expect(screen.getByRole("note", { name: /node render error/i }).textContent).toContain("bad");
  });

  it("contains unknown format versions", () => {
    render(
      <PayloadView
        payload={{ formatVersion: "vendo-genui/v99", root: "root", nodes: [] }}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByRole("note", { name: /unsupported ui format/i }).textContent).toContain("vendo-genui/v99");
  });

  it("dispatches additively registered future formats by tag", () => {
    registerTreeRenderer("vendo-genui/test-profile", ({ payload }) => (
      <p>Custom renderer: {String(payload.title)}</p>
    ));
    render(
      <PayloadView
        payload={{ formatVersion: "vendo-genui/test-profile", title: "compact" }}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.getByText("Custom renderer: compact")).toBeTruthy();
  });

  it("contains core validation failures before rendering", () => {
    const invalid = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{ id: "root", component: "Stack" }],
      components: { Stack: "export default function Stack() { return null }" },
    } as unknown as WalkTree;

    render(<TreeView tree={invalid} components={{}} onAction={ok} />);

    const notice = screen.getByRole("note", { name: /invalid ui tree/i });
    expect(notice.getAttribute("data-error-code")).toBe("provision");
    expect(notice.textContent).toMatch(/reserved/i);
  });
});

describe("TreeView bindings and outcomes", () => {
  it("resolves nested JSON Pointer bindings, escapes, the whole model, and missing paths", () => {
    const Probe: ComponentType<Record<string, unknown>> = (props) => (
      <output
        data-label={String(props.label)}
        data-escaped={String(props.escaped)}
        data-missing={String(props.missing)}
      >
        {JSON.stringify(props.nested)}
      </output>
    );
    const data = {
      user: { name: "Ada" },
      rows: [{ total: 42 }],
      "a/b": { "~key": "escaped value" },
    } satisfies Record<string, Json>;

    render(
      <TreeView
        tree={{
          ...tree([{
            id: "root",
            component: "Probe",
            source: "host",
            props: {
              label: { $path: "/user/name" },
              escaped: { $path: "/a~1b/~0key" },
              missing: { $path: "/not/here" },
              nested: { total: { $path: "/rows/0/total" }, all: { $path: "" } },
            },
          }]),
          data: { user: { name: "stale" } },
        }}
        data={data}
        components={{ Probe }}
        onAction={ok}
      />,
    );

    const output = screen.getByRole("status");
    expect(output.getAttribute("data-label")).toBe("Ada");
    expect(output.getAttribute("data-escaped")).toBe("escaped value");
    expect(output.getAttribute("data-missing")).toBe("undefined");
    expect(output.textContent).toContain('"total":42');
    expect(output.textContent).toContain('"user":{"name":"Ada"}');
  });

  it("updates $state reads and reports jail state-set messages", async () => {
    const StateProbe: ComponentType<{ value?: unknown }> = ({ value }) => <output>{String(value)}</output>;
    const onStateChange = vi.fn();
    render(
      <TreeView
        tree={tree(
          [
            { id: "root", component: "Row", children: ["generated", "probe"] },
            { id: "generated", component: "Editor", source: "generated" },
            { id: "probe", component: "StateProbe", source: "host", props: { value: { $state: "draft" } } },
          ],
          "root",
          { Editor: "export default function Editor() { return <div>editor</div> }" },
        )}
        components={{ StateProbe }}
        onAction={ok}
        onStateChange={onStateChange}
      />,
    );

    const iframe = screen.getByTitle("Generated component: Editor") as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "state-set", key: "draft", value: "saved locally" },
    }));

    await waitFor(() => expect(screen.getByText("saved locally")).toBeTruthy());
    expect(onStateChange).toHaveBeenLastCalledWith({ draft: "saved locally" });
  });

  it("resets $state when the tree root identity changes", async () => {
    const StateProbe: ComponentType<{ value?: unknown }> = ({ value }) => <output>{String(value)}</output>;
    const first = tree(
      [
        { id: "root-a", component: "Row", children: ["generated-a", "probe-a"] },
        { id: "generated-a", component: "Editor", source: "generated" },
        { id: "probe-a", component: "StateProbe", source: "host", props: { value: { $state: "draft" } } },
      ],
      "root-a",
      { Editor: "export default function Editor() { return <div>editor</div> }" },
    );
    const second = tree(
      [{ id: "root-b", component: "StateProbe", source: "host", props: { value: { $state: "draft" } } }],
      "root-b",
    );
    const view = render(<TreeView tree={first} components={{ StateProbe }} onAction={ok} />);
    const iframe = screen.getByTitle("Generated component: Editor") as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "state-set", key: "draft", value: "belongs to app A" },
    }));
    await waitFor(() => expect(screen.getByText("belongs to app A")).toBeTruthy());

    view.rerender(<TreeView tree={second} components={{ StateProbe }} onAction={ok} />);
    expect(screen.queryByText("belongs to app A")).toBeNull();
    expect(screen.getByText("undefined")).toBeTruthy();
  });

  it("turns $action props into callbacks and marks pending approval", async () => {
    const ActionButton: ComponentType<{ run?: () => Promise<ToolOutcome> }> = ({ run }) => (
      <button type="button" onClick={() => void run?.()}>Run action</button>
    );
    const onAction = vi.fn(async (): Promise<ToolOutcome> => ({
      status: "pending-approval",
      approvalId: "apr_one",
    }));

    render(
      <TreeView
        tree={tree([{
          id: "root",
          component: "ActionButton",
          source: "host",
          props: { run: { $action: "fn:submit", payload: { row: 7 } } },
        }])}
        components={{ ActionButton }}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    // The outcome attribute and notice only appear once the async onAction
    // promise resolves and React commits; wait on that observable state rather
    // than on the mock merely having been called.
    expect(await screen.findByRole("note", { name: /action pending approval/i })).toBeTruthy();
    expect(document.querySelector('[data-vendo-node-id="root"]')?.getAttribute("data-vendo-outcome"))
      .toBe("pending-approval");
    expect(onAction).toHaveBeenCalledWith({
      nodeId: "root",
      action: "fn:submit",
      payload: { row: 7 },
    });
  });

  it("ignores an unknown future ToolOutcome status without throwing a notice", async () => {
    const ActionButton: ComponentType<{ run?: () => Promise<ToolOutcome> }> = ({ run }) => (
      <button type="button" onClick={() => void run?.()}>Run future action</button>
    );
    const onAction = vi.fn(async () => ({ status: "future-thing" }) as unknown as ToolOutcome);

    render(
      <TreeView
        tree={tree([{
          id: "root",
          component: "ActionButton",
          source: "host",
          props: { run: { $action: "fn:future" } },
        }])}
        components={{ ActionButton }}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run future action" }));
    // Wait for the unknown outcome to actually land (root gains the raw status
    // attribute) before asserting no notice — otherwise the null check can pass
    // simply because the async result has not committed yet.
    await waitFor(() => expect(
      document.querySelector('[data-vendo-node-id="root"]')?.getAttribute("data-vendo-outcome"),
    ).toBe("future-thing"));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
