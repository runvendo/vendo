import { render, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { UINode } from "@flowlet/core";

const initialize = vi.fn();
const update = vi.fn();
// Keep the real @flowlet/stage exports (notably `createGenUISession`) and only
// stub the DOM-bound stage mount/controller so generated-node resolution runs
// against the real host session.
vi.mock("@flowlet/stage", async (importActual) => {
  const actual = await importActual<typeof import("@flowlet/stage")>();
  return {
    ...actual,
    createStage: (slot: HTMLElement) => {
      const iframe = document.createElement("iframe");
      slot.appendChild(iframe);
      return { iframe, endpoints: {} };
    },
    connectStage: () => ({
      initialize,
      update,
      resolveAction: vi.fn(),
      dispose: vi.fn(),
      ready: Promise.resolve(),
    }),
  };
});

import { FlowletStage } from "./stage-adapter";

const genPayload = (data: Record<string, unknown>) => ({
  formatVersion: "flowlet-genui/v1",
  root: "n1",
  nodes: [
    { id: "n1", component: "Card", source: "host", props: { title: { $path: "/title" } } },
  ],
  data,
});
const makeGenNode = (data: Record<string, unknown>): UINode => ({
  id: "g1",
  kind: "generated",
  payload: genPayload(data),
});

describe("FlowletStage", () => {
  it("initializes the stage with the first node, then updates on node change", async () => {
    const node = {
      id: "c1",
      kind: "component",
      source: "host",
      name: "Card",
      props: {},
    } as const;
    const { rerender } = render(
      <FlowletStage node={node} bundleSource="/*bundle*/" />,
    );
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(initialize.mock.calls[0][0]).toMatchObject({
      tree: node,
      bundleSource: "/*bundle*/",
    });
    const node2 = { ...node, props: { title: "x" } };
    rerender(<FlowletStage node={node2} bundleSource="/*bundle*/" />);
    await waitFor(() => expect(update).toHaveBeenCalled());
  });

  it("forwards componentTheme to initialize", async () => {
    const CT = { theme: { background: "#fff" }, mode: "light" as const };
    const node = { id: "c1", kind: "component", source: "host", name: "Card", props: {} } as const;
    update.mockClear();
    initialize.mockClear();
    render(<FlowletStage node={node} componentTheme={CT} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(initialize.mock.calls[0][0].componentTheme).toEqual(CT);
  });

  it("calls controller.update when theme prop changes", async () => {
    const node = { id: "c1", kind: "component", source: "host", name: "Card", props: {} } as const;
    update.mockClear();
    initialize.mockClear();
    const { rerender } = render(<FlowletStage node={node} theme={{ "--x": "red" }} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(<FlowletStage node={node} theme={{ "--x": "blue" }} />);
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ theme: { "--x": "blue" } })));
  });

  it("calls controller.update when state prop changes", async () => {
    const node = { id: "c1", kind: "component", source: "host", name: "Card", props: {} } as const;
    update.mockClear();
    initialize.mockClear();
    const { rerender } = render(<FlowletStage node={node} state={{ count: 0 }} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(<FlowletStage node={node} state={{ count: 1 }} />);
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ state: { count: 1 } })));
  });

  // FIX 3: a node with a NEW root id must RE-initialize, not update (which would no-op).
  it("re-initializes when the root node id changes", async () => {
    const nodeA = { id: "c1", kind: "component", source: "host", name: "Card", props: {} } as const;
    const nodeB = { id: "c2", kind: "component", source: "host", name: "Card", props: {} } as const;
    // Stable theme/state refs so the theme/state effects don't fire on rerender
    // and the only update() would come from the node path.
    const theme = {};
    const state = {};
    update.mockClear();
    initialize.mockClear();
    const { rerender } = render(<FlowletStage node={nodeA} theme={theme} state={state} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(<FlowletStage node={nodeB} theme={theme} state={state} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
    expect(initialize.mock.calls[1][0]).toMatchObject({ tree: nodeB });
    // It must NOT have routed the new-root change through update({ replace }).
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ replace: expect.anything() }));
  });

  // FIX 3: a mount-only prop change warns instead of silently no-op'ing.
  it("warns when bundleSource changes after init", async () => {
    const node = { id: "c1", kind: "component", source: "host", name: "Card", props: {} } as const;
    update.mockClear();
    initialize.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rerender } = render(<FlowletStage node={node} bundleSource="/*a*/" />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(<FlowletStage node={node} bundleSource="/*b*/" />);
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("bundleSource changed after init")),
    );
    warn.mockRestore();
  });

  // ---- Generated nodes (ENG-180) ----

  it("initializes a generated node with the session's resolved tree", async () => {
    update.mockClear();
    initialize.mockClear();
    render(<FlowletStage node={makeGenNode({ title: "Hello" })} bundleSource="/*b*/" />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    const arg = initialize.mock.calls[0][0];
    // The resolved component tree, not the raw generated payload.
    expect(arg.tree).toMatchObject({
      id: "n1",
      kind: "component",
      name: "Card",
      props: { title: "Hello" },
    });
    expect(arg.tree).not.toHaveProperty("payload");
  });

  it("drives a prop-level update (not re-init) when only generated data changes", async () => {
    update.mockClear();
    initialize.mockClear();
    const theme = {};
    const state = {};
    const { rerender } = render(
      <FlowletStage node={makeGenNode({ title: "Hello" })} theme={theme} state={state} />,
    );
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(<FlowletStage node={makeGenNode({ title: "World" })} theme={theme} state={state} />);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ replace: expect.anything() })),
    );
    // A data-only change must NOT remount via initialize.
    expect(initialize).toHaveBeenCalledTimes(1);
    const replaceCall = update.mock.calls.find((c) => c[0].replace);
    expect(replaceCall?.[0].replace).toMatchObject({
      nodeId: "n1",
      node: { props: { title: "World" } },
    });
  });

  it("re-initializes when the generated nodes change structurally", async () => {
    update.mockClear();
    initialize.mockClear();
    const theme = {};
    const state = {};
    const nodeA = makeGenNode({ title: "Hello" });
    const nodeB: UINode = {
      id: "g1",
      kind: "generated",
      payload: {
        formatVersion: "flowlet-genui/v1",
        root: "n1",
        nodes: [
          { id: "n1", component: "Banner", source: "host", props: { title: { $path: "/title" } } },
        ],
        data: { title: "Hello" },
      },
    };
    const { rerender } = render(<FlowletStage node={nodeA} theme={theme} state={state} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(<FlowletStage node={nodeB} theme={theme} state={state} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
    expect(initialize.mock.calls[1][0].tree).toMatchObject({ name: "Banner" });
  });

  it("logs and renders a visible error node on an invalid generated payload", async () => {
    update.mockClear();
    initialize.mockClear();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const node: UINode = {
      id: "g1",
      kind: "generated",
      payload: { formatVersion: "bogus/v9", root: "n1", nodes: [] },
    };
    render(<FlowletStage node={node} />);
    await waitFor(() =>
      expect(err).toHaveBeenCalledWith(
        expect.stringContaining("invalid generated payload"),
        expect.anything(),
      ),
    );
    // Per spec §6: a visible top-level error tree is initialized (not skipped).
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(initialize.mock.calls[0][0].tree).toMatchObject({
      id: "g1",
      kind: "component",
      name: "Text",
    });
    expect(initialize.mock.calls[0][0].tree.props.text).toContain(
      "Failed to render generated UI",
    );
    err.mockRestore();
  });

  // ---- Generated component code (Tier 2.5) ----

  it("re-initializes when only the components map changes (same nodes)", async () => {
    update.mockClear();
    initialize.mockClear();
    const theme = {};
    const state = {};
    const makeNode = (code: string): UINode => ({
      id: "g1",
      kind: "generated",
      payload: {
        formatVersion: "flowlet-genui/v1",
        root: "r",
        nodes: [{ id: "r", component: "Gauge", source: "generated" }],
        components: { Gauge: code },
      },
    });
    const { rerender } = render(
      <FlowletStage node={makeNode("export default function A(){}")} theme={theme} state={state} />,
    );
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(
      <FlowletStage node={makeNode("export default function B(){}")} theme={theme} state={state} />,
    );
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
  });

  it("passes generatedComponents through to initialize", async () => {
    update.mockClear();
    initialize.mockClear();
    const node: UINode = {
      id: "g1",
      kind: "generated",
      payload: {
        formatVersion: "flowlet-genui/v1",
        root: "r",
        nodes: [{ id: "r", component: "Gauge", source: "generated" }],
        components: { Gauge: "export default function A(){}" },
      },
    };
    render(<FlowletStage node={node} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(initialize.mock.calls[0][0].generatedComponents).toEqual({
      Gauge: "export default function A(){}",
    });
  });

  it("takes the delta path when only data changes and a components map is present", async () => {
    update.mockClear();
    initialize.mockClear();
    const theme = {};
    const state = {};
    const makeNode = (title: string): UINode => ({
      id: "g1",
      kind: "generated",
      payload: {
        formatVersion: "flowlet-genui/v1",
        root: "n1",
        nodes: [
          { id: "n1", component: "Card", source: "host", props: { title: { $path: "/title" } } },
        ],
        components: { Gauge: "export default function A(){}" },
        data: { title },
      },
    });
    const { rerender } = render(<FlowletStage node={makeNode("Hello")} theme={theme} state={state} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(<FlowletStage node={makeNode("World")} theme={theme} state={state} />);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ replace: expect.anything() })),
    );
    // Same nodes + same components ⇒ data-only change must NOT remount.
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("does not re-initialize when the components map key order differs but content is identical", async () => {
    update.mockClear();
    initialize.mockClear();
    const theme = {};
    const state = {};
    const nodes = [{ id: "r", component: "Gauge", source: "generated" as const }];
    const nodeA: UINode = {
      id: "g1",
      kind: "generated",
      payload: {
        formatVersion: "flowlet-genui/v1",
        root: "r",
        nodes,
        components: { Gauge: "export default function A(){}", Meter: "export default function M(){}" },
      },
    };
    const nodeB: UINode = {
      id: "g1",
      kind: "generated",
      payload: {
        formatVersion: "flowlet-genui/v1",
        root: "r",
        nodes,
        // Same content, reversed key insertion order.
        components: { Meter: "export default function M(){}", Gauge: "export default function A(){}" },
      },
    };
    const { rerender } = render(<FlowletStage node={nodeA} theme={theme} state={state} />);
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    rerender(<FlowletStage node={nodeB} theme={theme} state={state} />);
    // Give any re-init effect a chance to run, then assert it did NOT.
    await new Promise((r) => setTimeout(r, 50));
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
