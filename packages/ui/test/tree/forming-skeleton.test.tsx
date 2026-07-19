// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";
import { deriveFormShape, FormingSkeleton } from "../../src/tree/forming-skeleton.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

describe("deriveFormShape", () => {
  it("derives the silhouette from what the component name says it is", () => {
    expect(deriveFormShape("RenewalList")).toBe("rows");
    expect(deriveFormShape("AccountsTable")).toBe("rows");
    expect(deriveFormShape("ActivityFeed")).toBe("rows");
    expect(deriveFormShape("RenewalHero")).toBe("tiles");
    expect(deriveFormShape("KpiSummary")).toBe("tiles");
    expect(deriveFormShape("UsageMetrics")).toBe("tiles");
    expect(deriveFormShape("StatusBadge")).toBe("pill");
    expect(deriveFormShape("FilterChips")).toBe("pill");
  });

  it("keeps the historical slab for unrecognized names", () => {
    expect(deriveFormShape("RevenueCard")).toBe("slab");
    expect(deriveFormShape("Whatever")).toBe("slab");
  });
});

describe("FormingSkeleton", () => {
  it("renders a rows silhouette as stacked shimmer rows", () => {
    render(<FormingSkeleton name="RenewalList" />);
    const shape = document.querySelector('[data-form-shape="rows"]');
    expect(shape).not.toBeNull();
    expect(shape!.querySelectorAll('[data-primitive="Skeleton"]').length).toBe(3);
  });

  it("renders a tiles silhouette as a three-up shimmer band", () => {
    render(<FormingSkeleton name="RenewalHero" />);
    const shape = document.querySelector('[data-form-shape="tiles"]');
    expect(shape).not.toBeNull();
    expect(shape!.querySelectorAll('[data-primitive="Skeleton"]').length).toBe(3);
  });

  it("falls back to one 72px slab for unrecognized names", () => {
    render(<FormingSkeleton name="RevenueCard" />);
    const shape = document.querySelector('[data-form-shape="slab"]');
    expect(shape).not.toBeNull();
    expect(shape!.querySelectorAll('[data-primitive="Skeleton"]').length).toBe(1);
  });
});

describe("TreeView streaming placeholders (pick A)", () => {
  const streamingTree = (): WalkTree => ({
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["hero", "list"] },
      { id: "hero", component: "RenewalHero", source: "generated" },
      { id: "list", component: "RenewalList", source: "generated" },
    ],
    streaming: true,
  } as unknown as WalkTree);

  it("paints shape-aware silhouettes for unarrived generated sources", () => {
    render(<TreeView tree={streamingTree()} components={{}} onAction={ok} />);
    expect(document.querySelector('[data-streaming-component="RenewalHero"] [data-form-shape="tiles"]')).not.toBeNull();
    expect(document.querySelector('[data-streaming-component="RenewalList"] [data-form-shape="rows"]')).not.toBeNull();
  });

  it("marks shaped reveals for in-place fill instead of the rise morph", () => {
    render(<TreeView tree={streamingTree()} components={{}} onAction={ok} />);
    expect(document.querySelectorAll(".fl-reveal.fl-reveal-fill").length).toBe(2);
  });

  it("keeps the slab for dangling children (no name to derive from)", () => {
    render(
      <TreeView
        tree={{
          root: "root",
          nodes: [{ id: "root", component: "Stack", children: ["mystery"] }],
          streaming: true,
        } as unknown as WalkTree}
        components={{}}
        onAction={ok}
      />,
    );
    expect(document.querySelector('[data-dangling-node="mystery"] [data-primitive="Skeleton"]')).not.toBeNull();
  });
});
