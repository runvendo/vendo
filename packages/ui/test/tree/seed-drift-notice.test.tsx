// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";
import type { SeedDrift } from "../../src/wire-types.js";

afterEach(() => {
  cleanup();
});

/** A v2 payload rendered straight by TreeView: the walk shape plus the format tag. */
type Payload = WalkTree & { formatVersion: typeof VENDO_TREE_FORMAT };

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const DRIFT: SeedDrift = {
  component: "net-worth-card",
  componentName: "PinnedCard",
  baseline: "sha256:maple-old",
  current: "sha256:maple-new",
  reason: "baseline-changed",
};

const NOTICE = "Newer version available";

function driftedTree(seedDrift?: SeedDrift): Payload {
  const tree: Payload & { seedDrift?: SeedDrift } = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["card"] },
      { id: "card", component: "Text", props: { text: "Remixed net worth" } },
    ],
  };
  if (seedDrift !== undefined) tree.seedDrift = seedDrift;
  return tree;
}

describe("seed drift notice (06-apps §8)", () => {
  it("renders no drift notice when the payload carries no drift report", () => {
    render(<TreeView tree={driftedTree()} components={{}} onAction={ok} />);
    expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
  });

  it("says LOUDLY that the host component moved on — and what the update DOES", () => {
    render(<TreeView tree={driftedTree(DRIFT)} components={{}} onAction={ok} />);

    const notice = screen.getByRole("note", { name: NOTICE });
    expect(notice.textContent).toContain('"net-worth-card"');
    // Honest: updating REPLAYS the changes the person asked for, and says which
    // of them no longer fit — and nothing moves until they ask.
    expect(notice.textContent).toContain("replays every change you asked for");
    expect(notice.textContent).toContain("no longer fit");
    expect(notice.textContent).toContain("Nothing happens until you ask for it.");
    // Informational only: nothing is mutated without the user — the app's own
    // content still renders below the notice.
    expect(screen.getByText("Remixed net worth")).toBeTruthy();
  });

  it("tolerates a malformed drift field without breaking the surface", () => {
    render(
      <TreeView
        tree={driftedTree("not-a-report" as unknown as SeedDrift)}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
    expect(screen.getByText("Remixed net worth")).toBeTruthy();

    // ONE seed, ONE report: a LIST is not a drift report, so the pre-seed
    // payload shape reads as no drift rather than rendering a broken notice.
    render(
      <TreeView
        tree={driftedTree([DRIFT] as unknown as SeedDrift)}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
  });
});
