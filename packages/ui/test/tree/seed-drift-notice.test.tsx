// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { TreeView } from "../../src/tree/index.js";
import type { SeedDrift } from "../../src/wire-types.js";

afterEach(() => {
  cleanup();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const CARD_SOURCE = `
export default function PinnedCard() {
  return <strong>Remixed net worth</strong>;
}
`;

const DRIFT: SeedDrift = {
  component: "net-worth-card",
  componentName: "PinnedCard",
  baseline: "sha256:maple-old",
  current: "sha256:maple-new",
  reason: "baseline-changed",
};

const NOTICE = "Newer version available";

function driftedTree(seedDrift?: SeedDrift): UIPayload {
  const tree: UIPayload & { seedDrift?: SeedDrift } = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["card"] },
      { id: "card", component: "PinnedCard", source: "generated" },
    ],
    components: { PinnedCard: CARD_SOURCE },
  };
  if (seedDrift !== undefined) tree.seedDrift = seedDrift;
  return tree;
}

describe("seed drift notice (06-apps §8)", () => {
  it("renders no drift notice when the payload carries no drift report", () => {
    render(<TreeView tree={driftedTree()} components={{}} onAction={ok} />);
    expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
  });

  it("says LOUDLY that the host component moved on — and what the update COSTS", () => {
    render(<TreeView tree={driftedTree(DRIFT)} components={{}} onAction={ok} />);

    const notice = screen.getByRole("note", { name: NOTICE });
    expect(notice.textContent).toContain('"net-worth-card"');
    // Honest: updating hands over a fresh copy, so the person is told their own
    // changes go with it — and that nothing moves until they ask.
    expect(notice.textContent).toContain("fresh copy");
    expect(notice.textContent).toContain("would be replaced");
    expect(notice.textContent).toContain("Nothing happens until you ask for it.");
    // Informational only: nothing is mutated without the user — the remixed
    // component still renders in its jail below the notice.
    expect(document.querySelector('iframe[title="Generated component: PinnedCard"]')).not.toBeNull();
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
    expect(document.querySelector('iframe[title="Generated component: PinnedCard"]')).not.toBeNull();

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
