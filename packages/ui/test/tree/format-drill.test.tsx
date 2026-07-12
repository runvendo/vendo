// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import {
  PayloadView,
  registerTreeRenderer,
  type PayloadRendererProps,
} from "../../src/tree/index.js";

/**
 * FORMAT-EVOLUTION FIRE DRILL — the UI renderer-registry seam (08-ui §5; 01-core §8).
 *
 * Renderers key by `formatVersion`. This proves the evolution seam is OPEN: a
 * drill format registered ONLY in test code renders through the exact product
 * registration surface (`registerTreeRenderer`), an UNregistered tag contains to
 * a notice without breaking the page, and the v0 tree keeps rendering either way.
 * The browser suite (e2e/format-drill.spec.ts) proves the same three in a real
 * browser; this is the fast headless mirror.
 *
 * The drill tag lives ONLY in test files; it is never a default registration.
 */
const DRILL_FORMAT = "vendo/tree@2-drill";
const UNREGISTERED_FORMAT = "vendo/tree@2-drill-never-registered";

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

afterEach(cleanup);

/** A throwaway renderer for the drill format's block-list shape. */
function DrillRenderer({ payload }: PayloadRendererProps) {
  const blocks = (payload as { blocks?: Array<{ heading: string; body: string }> }).blocks ?? [];
  return (
    <section aria-label="Drill format surface">
      {blocks.map((block, index) => (
        <article key={index}>
          <h3>{block.heading}</h3>
          <p>{block.body}</p>
        </article>
      ))}
    </section>
  );
}

const drillPayload: UIPayload = {
  formatVersion: DRILL_FORMAT,
  blocks: [{ heading: "Quarterly revenue", body: "$4,200 across 3 invoices" }],
};

const v1Payload: UIPayload = {
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [{ id: "root", component: "Text", props: { text: "Instant invoice" } }],
};

const components: Record<string, ComponentType> = {};

describe("format-evolution fire drill — ui renderer registry", () => {
  it("contains an unregistered format tag to a notice, never breaking the page", () => {
    render(
      <div>
        <PayloadView payload={{ formatVersion: UNREGISTERED_FORMAT, blocks: [] }} components={components} onAction={ok} />
        <p>Host content after the unregistered surface survived.</p>
      </div>,
    );
    const notice = screen.getByRole("note", { name: "Unsupported UI format" });
    expect(notice.textContent).toContain(UNREGISTERED_FORMAT);
    expect(screen.getByText("Host content after the unregistered surface survived.")).toBeTruthy();
  });

  it("renders a registered drill format through the product registration surface", () => {
    registerTreeRenderer(DRILL_FORMAT, DrillRenderer);
    render(<PayloadView payload={drillPayload} components={components} onAction={ok} />);
    expect(screen.getByRole("region", { name: "Drill format surface" })).toBeTruthy();
    expect(screen.getByText("Quarterly revenue")).toBeTruthy();
    expect(screen.getByText("$4,200 across 3 invoices")).toBeTruthy();
    // No fallback notice: dispatch found the registered renderer.
    expect(screen.queryByRole("note", { name: "Unsupported UI format" })).toBeNull();
  });

  it("keeps rendering the v0 tree identically with the drill format registered", () => {
    registerTreeRenderer(DRILL_FORMAT, DrillRenderer);
    render(<PayloadView payload={v1Payload} components={components} onAction={ok} />);
    // The v1 renderer (registered by default) still owns its tag.
    expect(screen.getByText("Instant invoice")).toBeTruthy();
    expect(screen.queryByRole("note", { name: "Unsupported UI format" })).toBeNull();
  });
});
