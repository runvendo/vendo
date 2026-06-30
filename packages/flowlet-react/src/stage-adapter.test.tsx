import { render, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

const initialize = vi.fn();
const update = vi.fn();
vi.mock("@flowlet/stage", () => ({
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
}));

import { FlowletStage } from "./stage-adapter";

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
});
