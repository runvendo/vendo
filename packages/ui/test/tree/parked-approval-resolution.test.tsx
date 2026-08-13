// @vitest-environment jsdom
/**
 * A press the guard parked, from the stall to the repaint.
 *
 * The screen, the engine and the Kit controls are the real ones
 * (screen-bridge.test.tsx documents why nothing here is stubbed on the render
 * side). Two doubles, both of them the OTHER side of a seam by definition: the
 * host's `onAction`, and the wire. What the server actually writes into an
 * `ApprovalResolution` is held by
 * `packages/vendo/tests/parked-action-resolution.e2e.test.ts`, where the apps
 * runtime's write path and the umbrella's read path both run for real — so the
 * shape below cannot quietly drift away from the one that ships.
 *
 * The stall this closes: `pending-approval` is the honest answer at press time,
 * so the node painted "waiting for approval" and the screen sat on it forever —
 * including long after the server had resumed the call and changed the data.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { transform } from "sucrase";
import { bootScreen, flattenTree, warmScreenEngine } from "@vendoai/apps/contract";
import { VENDO_TREE_FORMAT, type Json, type ToolOutcome, type UIPayload } from "@vendoai/core";
import type { VendoClient } from "../../src/client.js";
import { APPROVALS_DECIDED_EVENT } from "../../src/client-impl.js";
import { VendoProvider } from "../../src/context.js";
import { PayloadView, type ParkedPress } from "../../src/tree/index.js";
import type { ApprovalResolution } from "../../src/wire-types.js";

afterEach(cleanup);

beforeAll(async () => {
  await warmScreenEngine();
}, 30_000);

const compile = (tsx: string): string =>
  transform(tsx, { transforms: ["typescript", "jsx", "imports"], production: true, jsxRuntime: "automatic" }).code;

const CATALOG = ["Stack", "Card", "Text", "Money", "Button"];

const TRANSFERS = `
import { Button, Card, Money, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function PendingTransfers() {
  const pending = useQuery("list_pending");
  return (
    <Stack gap={12}>
      <Text text={"Pending: " + pending.data.length} />
      {pending.data.map((row) => (
        <Card key={row.id} title={row.recipient}>
          <Money amount={row.amount_cents / 100} />
          <Button label={"Cancel " + row.recipient} onClick={async () => {
            await tools.cancel_transfer({ id: row.id });
          }} />
        </Card>
      ))}
    </Stack>
  );
}
`;

/** The same screen, with the flag a real generated one latches before it awaits
 *  — the "Sending…" nothing but a fresh boot can clear. */
const SENDING = `
import { useState } from "react";
import { Button, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function PendingTransfers() {
  const pending = useQuery("list_pending");
  const [sending, setSending] = useState(false);
  return (
    <Stack gap={12}>
      <Text text={"Pending: " + pending.data.length} />
      <Button label={sending ? "Sending…" : "Cancel Ada"} disabled={sending} onClick={async () => {
        setSending(true);
        await tools.cancel_transfer({ id: "tr_1" });
      }} />
    </Stack>
  );
}
`;

/** The shape generated screens actually write: the button that fires the
 *  mutation lives INSIDE a confirm panel, and pressing it closes the panel. So
 *  the node that fired is gone before the guard's answer comes back. */
const CONFIRMING = `
import { useState } from "react";
import { Button, Card, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function PayJordan() {
  const pending = useQuery("list_pending");
  const [confirming, setConfirming] = useState(false);
  return (
    <Stack gap={12}>
      <Text text={"Pending: " + pending.data.length} />
      <Card key="pay" title="Pay Jordan">
        {confirming ? (
          <Stack key="confirm" gap={8}>
            <Text text="Send $42 to Jordan?" />
            <Button label="Send now" onClick={async () => {
              setConfirming(false);
              await tools.pay_jordan({ amount_cents: 4200 });
            }} />
          </Stack>
        ) : (
          <Button label="Review" onClick={() => setConfirming(true)} />
        )}
      </Card>
    </Stack>
  );
}
`;

const ROWS = [
  { id: "tr_1", recipient: "Ada", amount_cents: 4_200 },
  { id: "tr_2", recipient: "Bob", amount_cents: 900 },
];

/** The Button inside Ada's card — the node whose press parks. */
const ADA_NODE = "root.Card:tr_1.1";
/** {@link CONFIRMING}'s three ids: the button that fires, the panel that closes
 *  under it, and the card that outlives both. */
const SEND_NODE = "root.Card:pay.Stack:confirm.1";
const CONFIRM_PANEL = "root.Card:pay.Stack:confirm";
const PAY_CARD = "root.Card:pay";
const APPROVAL = "apr_cancel_ada";

interface Call {
  nodeId: string;
  action: string;
  payload?: Json;
}

const payloadFor = (compiledSource: string, queries: Record<string, unknown>): UIPayload => {
  const first = bootScreen({ compiledSource, queries, catalog: CATALOG, now: Date.UTC(2026, 1, 1) });
  try {
    const flat = flattenTree(first.tree());
    return {
      formatVersion: VENDO_TREE_FORMAT,
      root: flat.root,
      nodes: Object.values(flat.nodes),
      interactive: { compiledSource, queries, queryPlan: [{ tool: "list_pending" }] },
    } as unknown as UIPayload;
  } finally {
    first.dispose();
  }
};

/**
 * The world behind one screen: rows the backend owns, a host pipe that parks
 * the cancel behind an approval, and the wire's answer for that approval.
 * `approve()` is the server doing what it really does — resuming the parked
 * call (the row goes) and recording the outcome for the surface to find.
 */
function world(source = TRANSFERS) {
  let rows = [...ROWS];
  let resolution: ApprovalResolution | undefined;
  const calls: Call[] = [];
  const parked: ParkedPress[] = [];
  return {
    calls,
    parked,
    of: (action: string): Call[] => calls.filter((call) => call.action === action),
    approve(): void {
      rows = rows.filter((row) => row.id !== "tr_1");
      resolution = { state: "executed", outcome: { status: "ok", output: { cancelled: true } } };
    },
    refuse(state: "declined" | "expired"): void {
      resolution = { state };
    },
    render() {
      const client = {
        approvals: {
          get: async (id: string): Promise<ApprovalResolution> => {
            if (id !== APPROVAL || resolution === undefined) throw new Error(`Approval ${id} was not found`);
            return resolution;
          },
        },
      } as unknown as VendoClient;
      const onAction = async (call: Call): Promise<ToolOutcome> => {
        calls.push(call);
        if (call.action === "list_pending") return { status: "ok", output: { data: rows } as Json };
        // The guard sends the mutation to approval: nothing has changed yet, and
        // that is exactly what the surface is told.
        return { status: "pending-approval", approvalId: APPROVAL };
      };
      return render(
        <VendoProvider client={client}>
          <PayloadView
            payload={payloadFor(compile(source), { list_pending: { data: rows } })}
            components={{}}
            onAction={onAction}
            onParked={(press) => parked.push(press)}
          />
        </VendoProvider>,
      );
    },
  };
}

/** Same-tab announcement: `client.approvals.decide` fires this the moment the
 *  POST returns, which is AFTER the server resumed the call. */
const announce = async (approved: boolean): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(APPROVALS_DECIDED_EVENT, { detail: { ids: [APPROVAL], approved } }));
  });
};

/** The pending notice, which is also the affordance back to a dismissed ask —
 *  and says so, in the name a screen reader hears. */
const waitingNotice = () => screen.getByRole("button", { name: /Waiting for your approval — review/u });

const parkAda = async (live: ReturnType<typeof world>): Promise<void> => {
  live.render();
  fireEvent.click(await screen.findByRole("button", { name: "Cancel Ada" }));
  await waitFor(() => expect(screen.getByText(/Waiting for your approval/u)).toBeTruthy());
};

describe("a parked press learns its answer", () => {
  it("announces the park, then clears the notice and re-reads once the call ran", async () => {
    const live = world();
    await parkAda(live);

    // The contract a surface builds an approval prompt against.
    expect(live.parked).toEqual([{ nodeId: ADA_NODE, approvalId: APPROVAL }]);
    // Nothing changed yet, so nothing is re-read — the press is genuinely parked.
    expect(live.of("list_pending")).toEqual([]);
    expect(screen.getByText("Pending: 2")).toBeTruthy();

    live.approve();
    await announce(true);

    // The stale notice is gone and the screen re-read the plan, so it paints
    // what the backend now holds rather than the list it was built from.
    await waitFor(() => expect(screen.getByText("Pending: 1")).toBeTruthy());
    expect(screen.queryByText(/Waiting for your approval/u)).toBeNull();
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("settles a refusal in place: the notice says so, over the data that did not change", async () => {
    const live = world();
    await parkAda(live);

    live.refuse("declined");
    await announce(false);

    await waitFor(() => expect(screen.getByText(/nothing was sent/u)).toBeTruthy());
    // The pending sentence is replaced, not stacked on top of.
    expect(screen.queryByText(/Waiting for your approval/u)).toBeNull();
    // The refusal re-reads too (that is what re-boots the screen), and the
    // re-read paints the truth it finds: nothing was sent, so nothing moved.
    expect(live.of("list_pending")).toHaveLength(1);
    expect(screen.getByText("Pending: 2")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel Ada" }) as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * THE DEAD SCREEN. A generated screen latches its own "Sending…" before it
   * awaits, and expects the row to be gone when it comes back. Deny — or Esc,
   * then the TTL — and nothing came back: the flag was still set, the button
   * still disabled, and the only way out was a page reload. Only a re-boot
   * clears in-screen state, so every terminal answer re-reads, not just yes.
   */
  it.each([["declined"], ["expired"]] as const)("re-arms the screen's own controls after %s", async (state) => {
    const live = world(SENDING);
    live.render();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel Ada" }));
    await waitFor(() => expect(screen.getByText(/Waiting for your approval/u)).toBeTruthy());
    // The screen's own flag, latched: nothing in the tree can clear it.
    expect(screen.getByRole("button", { name: "Sending…" })).toBeTruthy();

    live.refuse(state);
    await announce(false);

    const rearmed = await screen.findByRole("button", { name: "Cancel Ada" });
    expect((rearmed as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/nothing was sent/u)).toBeTruthy();
  });

  /**
   * Esc closes the modal without deciding, so the ask is still pending on the
   * server — and the queue drops it. The notice IS the way back: pressing it
   * re-raises the same park down the same channel the first one took, so
   * whichever surface answered that announcement asks again.
   */
  it("hands a dismissed ask back: pressing the pending notice re-raises the park", async () => {
    const live = world();
    await parkAda(live);
    expect(live.parked).toEqual([{ nodeId: ADA_NODE, approvalId: APPROVAL }]);

    fireEvent.click(waitingNotice());

    expect(live.parked).toEqual([
      { nodeId: ADA_NODE, approvalId: APPROVAL },
      { nodeId: ADA_NODE, approvalId: APPROVAL },
    ]);
    // Re-asking is not re-pressing: no second call reached the host.
    expect(live.of("cancel_transfer")).toHaveLength(1);
  });

  /**
   * THE ORPHANED ANSWER. A confirm panel closes the moment the button inside it
   * is pressed, so by the time the guard answers there is no node left holding
   * that press's slot — and the notice rendered nowhere at all: the button was
   * pressed and the surface said nothing, forever. Node ids are structural
   * paths, so the answer climbs to the nearest node still on screen.
   */
  it("keeps the answer on the nearest surviving ancestor when the fired node unmounts", async () => {
    const live = world(CONFIRMING);
    live.render();
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send now" }));

    // The panel that held the press is gone with it...
    await screen.findByRole("button", { name: "Review" });
    expect(document.querySelector(`[data-vendo-node-id="${CONFIRM_PANEL}"]`)).toBeNull();
    // ...and the answer to that press is on the card the panel hung under.
    const notice = await screen.findByRole("button", { name: /Waiting for your approval — review/u });
    expect(document.querySelector(`[data-vendo-node-id="${PAY_CARD}"]`)?.contains(notice)).toBe(true);

    // Re-raising it is still THAT press: the fired node's id, not the card's.
    expect(live.parked).toEqual([{ nodeId: SEND_NODE, approvalId: APPROVAL }]);
    fireEvent.click(notice);
    expect(live.parked).toEqual([
      { nodeId: SEND_NODE, approvalId: APPROVAL },
      { nodeId: SEND_NODE, approvalId: APPROVAL },
    ]);
  });

  it("lands the refusal for an unmounted press on that same ancestor", async () => {
    const live = world(CONFIRMING);
    live.render();
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await screen.findByText(/Waiting for your approval/u);

    live.refuse("declined");
    await announce(false);

    const refusal = await screen.findByText(/nothing was sent/u);
    expect(document.querySelector(`[data-vendo-node-id="${PAY_CARD}"]`)?.contains(refusal)).toBe(true);
    expect(screen.queryByText(/Waiting for your approval/u)).toBeNull();
  });

  it("says an unanswered approval expired, in its own words", async () => {
    const live = world();
    await parkAda(live);

    live.refuse("expired");
    await announce(false);

    await waitFor(() => expect(screen.getByText(/nobody answered in time/u)).toBeTruthy());
    expect(screen.getByText("Pending: 2")).toBeTruthy();
  });

  it("finds a decision made where this page could not hear it", async () => {
    const live = world();
    await parkAda(live);

    // No announcement at all — the person approved in another tab, or the host's
    // own queue did. The poll is the only way this screen ever finds out.
    live.approve();

    await waitFor(() => expect(screen.getByText("Pending: 1")).toBeTruthy(), { timeout: 20_000 });
    expect(screen.queryByText(/Waiting for your approval/u)).toBeNull();
  }, 30_000);
});
