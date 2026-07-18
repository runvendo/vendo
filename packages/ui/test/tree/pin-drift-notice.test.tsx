// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT_V2, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { TreeView } from "../../src/tree/index.js";
import type { PinDrift } from "../../src/tree/renderer.js";

afterEach(() => {
  cleanup();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const CARD_SOURCE = `
export default function PinnedCard() {
  return <strong>Remixed net worth</strong>;
}
`;

const DRIFT: PinDrift = {
  slot: "net-worth-card",
  component: "PinnedCard",
  baseHash: "sha256:maple-old",
  baselineHash: "sha256:maple-new",
  reason: "baseline-changed",
};

function driftedTree(pinDrift?: PinDrift[]): UIPayload {
  const tree: UIPayload & { pinDrift?: PinDrift[] } = {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["card"] },
      { id: "card", component: "PinnedCard", source: "generated" },
    ],
    components: { PinnedCard: CARD_SOURCE },
  };
  if (pinDrift !== undefined) tree.pinDrift = pinDrift;
  return tree;
}

describe("pin drift notice (06-apps §8)", () => {
  it("renders no drift notice when the payload carries no drift report", () => {
    render(<TreeView tree={driftedTree()} components={{}} onAction={ok} />);
    expect(screen.queryByRole("note", { name: "Remixed component out of date" })).toBeNull();
  });

  it("says LOUDLY that the host component moved on, while the fork keeps rendering", () => {
    render(<TreeView tree={driftedTree([DRIFT])} components={{}} onAction={ok} />);

    const notice = screen.getByRole("note", { name: "Remixed component out of date" });
    expect(notice.textContent).toContain('"net-worth-card"');
    expect(notice.textContent).toContain("rebase");
    // Informational only: nothing is mutated without the user — the remixed
    // component still renders in its jail below the notice.
    expect(document.querySelector('iframe[title="Generated component: PinnedCard"]')).not.toBeNull();
  });

  it("lists every drifted slot in one notice", () => {
    render(
      <TreeView
        tree={driftedTree([
          DRIFT,
          { slot: "invoice-card", component: "PinnedInvoice", baseHash: "sha256:a", reason: "baseline-missing" },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    const notice = screen.getByRole("note", { name: "Remixed component out of date" });
    expect(notice.textContent).toContain('"net-worth-card"');
    expect(notice.textContent).toContain('"invoice-card"');
    expect(notice.textContent).toContain("they were");
  });

  it("treats an empty drift report as no drift", () => {
    render(<TreeView tree={driftedTree([])} components={{}} onAction={ok} />);
    expect(screen.queryByRole("note", { name: "Remixed component out of date" })).toBeNull();
  });

  it("tolerates a malformed drift field without breaking the surface", () => {
    render(
      <TreeView
        tree={driftedTree("not-a-report" as unknown as PinDrift[])}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.queryByRole("note", { name: "Remixed component out of date" })).toBeNull();
    expect(document.querySelector('iframe[title="Generated component: PinnedCard"]')).not.toBeNull();

    render(
      <TreeView
        tree={driftedTree([null, 7, { slot: "net-worth-card", component: "PinnedCard", baseHash: "sha256:a", reason: "baseline-changed" }] as unknown as PinDrift[])}
        components={{}}
        onAction={ok}
      />,
    );
    const notice = screen.getByRole("note", { name: "Remixed component out of date" });
    expect(notice.textContent).toContain('"net-worth-card"');
  });
});
