// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type Json, type ToolOutcome } from "@vendoai/core";
import { PayloadView, TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

function tree(nodes: WalkTree["nodes"], root = nodes[0]?.id ?? "root", components?: Record<string, string>): WalkTree {
  return { formatVersion: VENDO_TREE_FORMAT, root, nodes, components };
}

describe("TreeView public surface", () => {
  it("renders the built-in Kit layout components", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["heading", "row", "grid", "surface", "card", "divider"] },
          { id: "heading", component: "Text", props: { text: "Tree heading", variant: "heading" } },
          { id: "row", component: "Row" },
          { id: "grid", component: "Grid", props: { columns: 3 } },
          { id: "surface", component: "Surface" },
          { id: "card", component: "Card", props: { title: "Spend" } },
          { id: "divider", component: "Divider" },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Tree heading").getAttribute("data-kit")).toBe("Text");
    for (const name of ["Stack", "Row", "Grid", "Surface", "Card", "Divider"]) {
      expect(document.querySelector(`[data-kit="${name}"]`)).not.toBeNull();
    }
  });

  /** R4 containment, for the two names V4 retired: a stored app naming
   *  `Table`/`Skeleton` must show the contained notice on THAT node while every
   *  sibling still renders — never a blank surface. */
  it("contains a retired Table node while its siblings still render", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["before", "gone", "after"] },
          { id: "before", component: "Text", props: { text: "Above the table" } },
          { id: "gone", component: "Table", props: { rows: [], columns: ["a"] } },
          { id: "after", component: "Stat", props: { label: "Total", value: 42 } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByRole("note", { name: /unknown component/i }).textContent).toContain("Table");
    // The siblings are the point: containment, not a dead surface.
    expect(screen.getByText("Above the table")).toBeTruthy();
    expect(document.querySelector('[data-kit="Stat"]')).not.toBeNull();
    expect(screen.getByText("42")).toBeTruthy();
  });

  /** V4 — `Skeleton` left the vocabulary with the legacy family; a tree naming
   *  it is now an unknown component, contained like any other. */
  it("contains a tree node naming the retired Skeleton primitive", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["gone", "kept"] },
          { id: "gone", component: "Skeleton" },
          { id: "kept", component: "Text", props: { text: "Sibling survived" } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByRole("note", { name: /unknown component/i }).textContent).toContain("Skeleton");
    expect(screen.getByText("Sibling survived")).toBeTruthy();
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

    expect(document.querySelector('[data-dangling-node="not-yet-streamed"] [data-skeleton]')).not.toBeNull();
  });

  it("skeletons a generated node until its streamed source arrives", () => {
    const partial = {
      ...tree([{ id: "root", component: "RevenueCard", source: "generated" }]),
      streaming: true,
    } as WalkTree;

    render(<TreeView tree={partial} components={{}} onAction={ok} />);

    expect(document.querySelector('[data-streaming-component="RevenueCard"] [data-skeleton]')).not.toBeNull();
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

  it("skeletons an empty STREAMING tree instead of flashing the empty-tree notice", () => {
    // A partial stream legitimately passes through content-less shapes on its
    // way to the full tree; the loud notice is for FINAL payloads only.
    const partial = {
      ...tree([{ id: "root", component: "Stack", source: "prewired" }]),
      streaming: true,
    } as WalkTree;

    render(<TreeView tree={partial} components={{}} onAction={ok} />);

    expect(screen.queryByRole("note", { name: /empty ui tree/i })).toBeNull();
    expect(document.querySelector('[data-skeleton]')).not.toBeNull();
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
    // ⚠️ TEST EDIT (M36): this asserted the NODE ID ("bad") in the notice's text.
    // The id is our plumbing and the exception's message is generated-component
    // code talking; both are now the dev-mode `detail`. The notice a person
    // reads says what happened.
    const note = screen.getByRole("note", { name: /node render error/i });
    expect(note.textContent).toContain("didn’t load");
    expect(note.textContent).not.toContain("bad");
  });

  it("skeletons an erroring host node while STREAMING, then verdicts on the final payload", () => {
    // Demo-latency lane — mid-stream, a host component crash (partial props,
    // half-arrived data) is a transient: the region holds the silhouette and
    // the latch retries on the next prefix. The loud "Node render error"
    // notice is a verdict reserved for FINAL payloads.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error("host render exploded");
    };
    const nodes: WalkTree["nodes"] = [
      { id: "root", component: "Row", children: ["bad"] },
      { id: "bad", component: "Boom", source: "host" },
    ];
    const partial = { ...tree(nodes), streaming: true } as WalkTree;

    const view = render(<TreeView tree={partial} components={{ Boom }} onAction={ok} />);
    expect(screen.queryByRole("note", { name: /node render error/i })).toBeNull();
    expect(document.querySelector('[data-skeleton]')).not.toBeNull();

    // The FINAL payload (streaming flag gone) re-evaluates fresh: the crash
    // is now a verdict and the notice renders.
    view.rerender(<TreeView tree={tree(nodes)} components={{ Boom }} onAction={ok} />);
    // ⚠️ TEST EDIT (M36): as above — the verdict is the honest line, not the id.
    expect(screen.getByRole("note", { name: /node render error/i }).textContent)
      .toContain("didn’t load");
  });

  it("settles on the skeleton when a node starts crashing MID-stream, instead of retrying itself", () => {
    // The mid-stream retry exists so ARRIVING DATA can heal a crash. It must
    // never be driven by the boundary's own re-render: a node that keeps
    // throwing has to settle on the silhouette after one attempt, not spin the
    // latch until React's nested-update guard kills the surface.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let renders = 0;
    let exploding = false;
    const Sometimes = () => {
      renders += 1;
      if (exploding) throw new Error("host render exploded");
      return <p>Half a view</p>;
    };
    const nodes: WalkTree["nodes"] = [
      { id: "root", component: "Row", children: ["node"] },
      { id: "node", component: "Sometimes", source: "host" },
    ];
    const streaming = () => ({ ...tree(nodes), streaming: true }) as WalkTree;

    const view = render(<TreeView tree={streaming()} components={{ Sometimes }} onAction={ok} />);
    expect(screen.getByText("Half a view")).toBeTruthy();

    const before = renders;
    exploding = true;
    view.rerender(<TreeView tree={streaming()} components={{ Sometimes }} onAction={ok} />);

    // React re-renders a handful of times recovering from the throw itself.
    // The self-retry is what unbounds it: it ran the crashing node 109 times
    // in this one update and stopped only at React's nested-update guard.
    expect(renders - before).toBeLessThan(10);
    expect(document.querySelector("[data-skeleton]")).not.toBeNull();
    expect(screen.queryByRole("note", { name: /node render error/i })).toBeNull();
  });

  it("skeletons an unknown component name while STREAMING instead of the unknown-component notice", () => {
    const partial = {
      ...tree([
        { id: "root", component: "Row", children: ["mystery"] },
        { id: "mystery", component: "NotYetDefined", source: "host" },
      ]),
      streaming: true,
    } as WalkTree;

    render(<TreeView tree={partial} components={{}} onAction={ok} />);

    expect(screen.queryByRole("note", { name: /unknown component/i })).toBeNull();
    expect(document.querySelector('[data-streaming-component="NotYetDefined"]')).not.toBeNull();
  });

  it("skeletons a data-shape mismatch while STREAMING instead of the data-shape notice", () => {
    // A reshape mismatch over half-arrived data is a transient mid-stream;
    // the notice is for final payloads.
    const nodes: WalkTree["nodes"] = [
      { id: "root", component: "Row", children: ["stat"] },
      {
        id: "stat",
        component: "Text",
        props: { text: { $path: "/metric/rows", $reshape: [{ op: "sum", field: "amount" }] } },
      },
    ];
    const data = { metric: { rows: [{ amount: "not-a-number" }] } };

    // Control: the same mismatch on a FINAL payload verdicts loudly — proves
    // these inputs really trip the mismatch path.
    const view = render(<TreeView tree={tree(nodes)} components={{}} data={data} onAction={ok} />);
    expect(screen.getByRole("note", { name: /data shape/i })).toBeTruthy();

    const partial = { ...tree(nodes), streaming: true } as WalkTree;
    view.rerender(<TreeView tree={partial} components={{}} data={data} onAction={ok} />);
    expect(screen.queryByRole("note", { name: /data shape/i })).toBeNull();
  });

  it("skeletons an invalid STREAMING payload instead of the invalid-tree notice", () => {
    const payload = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack" },
        { id: "root", component: "Stack" }, // duplicate id → validateTree fails
      ],
      streaming: true,
    } as unknown as Parameters<typeof PayloadView>[0]["payload"];

    render(<PayloadView payload={payload} components={{}} onAction={ok} />);

    expect(screen.queryByRole("note", { name: /invalid ui tree/i })).toBeNull();
    expect(document.querySelector('[data-skeleton]')).not.toBeNull();
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

  it("contains core validation failures before rendering", () => {
    const invalid = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [{ id: "root", component: "Stack" }],
      components: { Stack: "export default function Stack() { return null }" },
    } as unknown as WalkTree;

    render(<TreeView tree={invalid} components={{}} onAction={ok} />);

    const notice = screen.getByRole("note", { name: /invalid ui tree/i });
    expect(notice.getAttribute("data-error-code")).toBe("provision");
    expect(notice.textContent).toMatch(/shadows a Kit component/i);
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
