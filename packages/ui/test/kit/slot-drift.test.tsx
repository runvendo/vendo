// @vitest-environment jsdom
/**
 * THE LAW: the catalog may not teach a slot the Kit does not render.
 *
 * `SLOTS` (apps contract/kit/specs.ts) feeds three consumers — `kitPrompt`
 * teaches it, `kit-nesting` enforces it, and the renderer reifies it — but none
 * of them can see whether the React component on the other end actually PAINTS
 * what is put there. When it does not, every stage passes and the person gets a
 * blank: the model is told to write `header`, the checks admit it, and the
 * component drops it. That is the silent-breakage class the table exists to
 * refuse, arriving through the table itself. It shipped once, at a scale of ~22
 * slots across 19 components, which is why this guard exists.
 *
 * So: every declared slot must have a probe here, and that probe must find its
 * marker in the DOM. A slot added to the table without an implementation fails
 * on the missing probe; one wired to a prop the component ignores fails on the
 * render. Neither can reach a user.
 */
import type { ComponentType, ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KIT_COMPONENTS, KIT_SPECS } from "../../src/kit/registry.js";

afterEach(cleanup);

/** Where each declared slot sits in its component's props, with the minimum
 *  other props that component needs to paint at all. Keyed `Component.slot`. */
const PROBES: Record<string, (probe: ReactNode) => Record<string, unknown>> = {
  "DataTable.cell": (probe) => ({ rows: [{ k: "v" }], columns: [{ key: "k", cell: probe }] }),
  "CardList.cell": (probe) => ({ items: [{ k: "v" }], fields: [{ key: "k", cell: probe }] }),
  "KeyValue.cell": (probe) => ({ record: { k: "v" }, items: [{ key: "k", cell: probe }] }),
  "Timeline.cell": (probe) => ({ entries: [{ id: "1" }], cell: probe }),
  "Timeline.marker": (probe) => ({ entries: [{ id: "1" }], marker: probe }),
  "Tabs.content": (probe) => ({ tabs: [{ label: "One", content: probe }] }),
  "Accordion.content": (probe) => ({ items: [{ label: "One", content: probe }], defaultOpen: [0] }),
};

describe("every declared slot renders what it promises", () => {
  it("paints a probe put in each slot the catalog teaches", () => {
    const declared = KIT_SPECS.flatMap((spec) =>
      Object.keys(spec.slots ?? {}).map((slot) => [spec.name, slot] as const));
    // The table is the subject: an empty sweep would pass this test in silence.
    expect(declared.length).toBeGreaterThan(0);

    for (const [component, slot] of declared) {
      const key = `${component}.${slot}`;
      const probe = PROBES[key];
      expect(probe, `${key} is declared in SLOTS with no probe here — implement the slot in @vendoai/ui and probe it, or drop it from the table`).toBeTypeOf("function");
      const Implementation = KIT_COMPONENTS[component] as ComponentType<Record<string, unknown>>;
      render(<Implementation {...probe(<span data-testid="probe">probe</span>)} />);
      expect(screen.queryByTestId("probe"), `<${component}> declares a "${slot}" slot and does not render it — the prompt would teach a place the renderer drops`).toBeTruthy();
      cleanup();
    }
  });
});
