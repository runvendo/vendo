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
import type { KitSlotSpec } from "../../src/kit/schema.js";

afterEach(cleanup);

/** The minimum a component needs to paint at all, BESIDE its slot: `props` for
 *  the component, `item` to seed the description object a nested slot rides in.
 *  The slot's PLACEMENT is deliberately not written here — it comes from the
 *  `at` declaration, so the path this renders through is the same path
 *  `kit-nesting` admits. Point `at` somewhere the component does not read and
 *  this test goes red. */
const CONTEXT: Record<string, { props: Record<string, unknown>; item?: Record<string, unknown> }> = {
  DataTable: { props: { rows: [{ k: "v" }] }, item: { key: "k" } },
  CardList: { props: { items: [{ k: "v" }] }, item: { key: "k" } },
  KeyValue: { props: { record: { k: "v" } }, item: { key: "k" } },
  Timeline: { props: { entries: [{ id: "1" }] } },
  Tabs: { props: {}, item: { label: "One" } },
  Accordion: { props: { defaultOpen: [0] }, item: { label: "One" } },
};

/** The probe at the slot's DECLARED path: a nested slot sits in its prop's
 *  description objects, a top-level one is the prop itself. */
const propsFor = (
  context: { props: Record<string, unknown>; item?: Record<string, unknown> },
  name: string,
  slot: KitSlotSpec,
  probe: ReactNode,
): Record<string, unknown> => slot.at === undefined
  ? { ...context.props, [name]: probe }
  : { ...context.props, [slot.at]: [{ ...context.item, [name]: probe }] };

describe("every declared slot renders what it promises", () => {
  it("paints a probe put at each slot's declared path", () => {
    const declared = KIT_SPECS.flatMap((spec) =>
      Object.entries(spec.slots ?? {}).map(([name, slot]) => [spec.name, name, slot] as const));
    // The table is the subject: an empty sweep would pass this test in silence.
    expect(declared.length).toBeGreaterThan(0);

    for (const [component, name, slot] of declared) {
      const at = `${component}.${slot.at === undefined ? name : `${slot.at}[].${name}`}`;
      const context = CONTEXT[component];
      expect(context, `${at} is declared in SLOTS with no context here — implement the slot in @vendoai/ui and add one, or drop it from the table`).toBeTypeOf("object");
      const Implementation = KIT_COMPONENTS[component] as ComponentType<Record<string, unknown>>;
      render(<Implementation {...propsFor(context!, name, slot, <span data-testid="probe">probe</span>)} />);
      expect(screen.queryByTestId("probe"), `<${component}> declares its "${name}" slot at ${at} and does not render what is put there`).toBeTruthy();
      cleanup();
    }
  });
});
