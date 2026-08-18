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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KIT_COMPONENTS, KIT_SPECS } from "../../src/kit/registry.js";
import type { KitSlotSpec } from "../../src/kit/schema.js";

afterEach(cleanup);

/** jsdom has no layout engine, so every box it reports is 0×0 — and recharts
 *  refuses to draw into one, which would leave a chart's slots unprobeable for
 *  a reason that has nothing to do with whether they are wired. This supplies
 *  the measurement and nothing else: the chart, the slot and the component are
 *  all the real ones. */
beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly report: (entries: unknown[]) => void) {}
    observe(target: Element) {
      this.report([{ target, contentRect: { width: 400, height: 200, top: 0, left: 0, x: 0, y: 0 } }]);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

/** The minimum a component needs to paint at all, BESIDE its slot: `props` for
 *  the component, `item` to seed the description object a nested slot rides in.
 *  The slot's PLACEMENT is deliberately not written here — it comes from the
 *  `at` declaration, so the path this renders through is the same path
 *  `kit-nesting` admits. Point `at` somewhere the component does not read and
 *  this test goes red.
 *
 *  Keyed by `Component.slot` where ONE slot needs a different world from the
 *  rest of its component's, and by `Component` for the rest: an `empty` slot is
 *  the case, since it paints only where there is no data and every other slot
 *  on the same component needs some. */
const CONTEXT: Record<string, { props: Record<string, unknown>; item?: Record<string, unknown> }> = {
  Surface: { props: {} },
  Card: { props: {} },
  Divider: { props: {} },
  DataTable: { props: { rows: [{ k: "v" }] }, item: { key: "k" } },
  "DataTable.empty": { props: { rows: [] } },
  CardList: { props: { items: [{ k: "v" }] }, item: { key: "k" } },
  "CardList.empty": { props: { items: [] } },
  KeyValue: { props: { record: { k: "v" } }, item: { key: "k" } },
  Timeline: { props: { entries: [{ id: "1" }] } },
  "Timeline.empty": { props: { entries: [] } },
  Stat: { props: { label: "Open", value: 1 } },
  LineChart: { props: { data: [{ x: "Jan", v: 1 }], xKey: "x", series: ["v"] } },
  "LineChart.empty": { props: { data: [], xKey: "x", series: ["v"] } },
  BarChart: { props: { data: [{ x: "Jan", v: 1 }], xKey: "x", series: ["v"] } },
  "BarChart.empty": { props: { data: [], xKey: "x", series: ["v"] } },
  DonutChart: { props: { data: [{ k: "A", v: 1 }], categoryKey: "k", valueKey: "v" } },
  "DonutChart.empty": { props: { data: [], categoryKey: "k", valueKey: "v" } },
  Progress: { props: { value: 0.5 } },
  // `hint` is a SHARED slot now, so it lands on every control that takes one
  // rather than the three that used to be listed here — and each of them needs a
  // world of its own only where a required prop says so.
  Input: { props: {} },
  Textarea: { props: {} },
  Select: { props: { options: ["One"] } },
  Combobox: { props: { options: ["One"] } },
  Radio: { props: { options: ["One"] } },
  DatePicker: { props: {} },
  DateRange: { props: {} },
  Checkbox: { props: {} },
  Switch: { props: {} },
  Slider: { props: {} },
  Form: { props: {} },
  Tabs: { props: {}, item: { label: "One" } },
  Accordion: { props: { defaultOpen: [0] }, item: { label: "One" } },
  EmptyState: { props: { title: "Nothing yet" } },
  Steps: { props: { items: [{ label: "One" }] } },
  // A dialog paints nothing at all while it is down, so the probe would never
  // land no matter how faithfully the slot is wired. `open` is the truth these
  // two follow; raise them and the slots are on the same footing as everyone
  // else's here.
  Modal: { props: { open: true, onClose: () => {} } },
  Sheet: { props: { open: true, onClose: () => {} } },
  // A tooltip is down for the same reason, and has no `open` to raise it: it
  // comes up on hover, so it is hovered below. The child is what there is to
  // hover.
  Tooltip: { props: { children: <span>control</span> } },
};

/** What it takes to bring a component UP where a prop cannot. The Tooltip's own
 *  test hovers exactly this way — a real `mouseenter` (Base UI listens for the
 *  native event, not React's delegated one) and then a move. */
const RAISE: Record<string, (container: HTMLElement) => void> = {
  Tooltip: (container) => {
    const trigger = container.querySelector('[data-kit="Tooltip"]');
    if (trigger === null) return;
    trigger.dispatchEvent(new window.MouseEvent("mouseenter"));
    fireEvent.mouseMove(trigger);
  },
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
  it("paints a probe put at each slot's declared path", async () => {
    const declared = KIT_SPECS.flatMap((spec) =>
      Object.entries(spec.slots ?? {}).map(([name, slot]) => [spec.name, name, slot] as const));
    // The table is the subject: an empty sweep would pass this test in silence.
    expect(declared.length).toBeGreaterThan(0);

    for (const [component, name, slot] of declared) {
      const at = `${component}.${slot.at === undefined ? name : `${slot.at}[].${name}`}`;
      const context = CONTEXT[`${component}.${name}`] ?? CONTEXT[component];
      expect(context, `${at} is declared in SLOTS with no context here — implement the slot in @vendoai/ui and add one, or drop it from the table`).toBeTypeOf("object");
      const Implementation = KIT_COMPONENTS[component] as ComponentType<Record<string, unknown>>;
      const { container } = render(<Implementation {...propsFor(context!, name, slot, <span data-testid="probe">probe</span>)} />);
      RAISE[component]?.(container);
      // `findBy` rather than `queryBy` because a raised component arrives after
      // its own delay; a probe already painted resolves on the first look, and
      // only a REAL miss waits out the timeout — with the sentence intact,
      // which is what a bare `findBy` would throw away.
      const painted = await screen.findByTestId("probe", {}, { timeout: 3000 }).catch(() => null);
      expect(painted, `<${component}> declares its "${name}" slot at ${at} and does not render what is put there`).toBeTruthy();
      cleanup();
    }
  });
});
