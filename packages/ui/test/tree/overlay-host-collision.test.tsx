// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const tree = (nodes: WalkTree["nodes"]): WalkTree =>
  ({ formatVersion: VENDO_TREE_FORMAT, root: nodes[0]!.id, nodes } as WalkTree);

const shellOf = (nodeId: string): HTMLElement =>
  document.querySelector(`[data-vendo-node-id="${nodeId}"]`) as HTMLElement;

function HostModal({ children }: { children?: ReactNode }) {
  return <div data-testid="host-modal">{children}</div>;
}

/**
 * An overlay brick paints on the body-level host, so its shell generates no box.
 * That is right for OUR Modal and wrong for everyone else's: hosts name their
 * own components, and a host `Modal` is an ordinary in-flow component. Deciding
 * it by name alone cost the host's component its layout box.
 */
describe("a host component colliding with an overlay name", () => {
  it("keeps its layout box when the host owns the name", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["m"] },
          { id: "m", component: "Modal", source: "host" },
        ])}
        components={{ Modal: HostModal }}
        onAction={ok}
      />,
    );
    expect(screen.getByTestId("host-modal")).toBeTruthy();
    expect(shellOf("m").style.display).toBe("");
  });

  it("still gives OUR Modal the boxless shell", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["m"] },
          { id: "m", component: "Modal", props: { open: false } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );
    expect(shellOf("m").style.display).toBe("contents");
  });

  it("falls back to OUR Modal when the node claims host but the host supplies none", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["m"] },
          { id: "m", component: "Modal", source: "host", props: { open: false } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );
    expect(shellOf("m").style.display).toBe("contents");
  });
});
