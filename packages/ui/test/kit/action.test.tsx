import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Json, ToolOutcome } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VendoAppProvider } from "../../src/kit/app-context.js";
import { useToolAction } from "../../src/kit/action.js";
import { useToolQuery } from "../../src/kit/query.js";
import { startDoor, type Door } from "./wire-fixture.js";

afterEach(cleanup);

const doors: Door[] = [];
afterEach(async () => {
  await Promise.all(doors.splice(0).map((door) => door.close()));
});

const door = async (answer: Door["answer"]): Promise<Door> => {
  const started = await startDoor(answer);
  doors.push(started);
  return started;
};

const mount = (open: Door, ui: React.ReactNode) =>
  render(<VendoAppProvider appId="app_1" baseUrl={open.baseUrl}>{ui}</VendoAppProvider>);

/** A screen with a read and a write, the way a generated app has both. */
function Screen({ pendings }: { pendings?: boolean[] }) {
  const balance = useToolQuery("host_getBalance");
  const pay = useToolAction("host_payBill");
  pendings?.push(pay.pending);
  return (
    <div>
      <span data-testid="balance">{JSON.stringify(balance.data)}</span>
      <span data-testid="pending">{String(pay.pending)}</span>
      <span data-testid="notice">{pay.outcome === undefined ? "none" : pay.outcome.status}</span>
      <span data-testid="loading">{String(balance.loading)}</span>
      <button type="button" onClick={() => void pay.run({ billId: "b_1" })}>pay</button>
    </div>
  );
}

const settled = async () => {
  await waitFor(() => {
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });
};

const press = async (name: string) => {
  await act(async () => {
    screen.getByRole("button", { name }).click();
  });
};

describe("useToolAction — the write, over the same door", () => {
  it("calls POST <base>/apps/:appId/call with the ref and the payload", async () => {
    const open = await door((call) =>
      call.ref === "host_payBill" ? { status: "ok", output: { paid: true } } : { status: "ok", output: 500 });
    mount(open, <Screen />);
    await settled();
    await press("pay");
    // The write is fire-and-forget (`onClick={() => void pay.run(...)}`), and the
    // door records a call only when its HTTP server has RECEIVED the POST — a
    // macrotask past what `act(click)` flushes. Asserting on `open.calls`
    // synchronously races that receipt (green on fast loopback, red under a
    // slower CI scheduler). Wait for the POST to land, then assert its shape.
    await waitFor(() => {
      expect(open.calls.find((call) => call.ref === "host_payBill")).toBeDefined();
    });
    expect(open.calls.find((call) => call.ref === "host_payBill")).toEqual({
      appId: "app_1",
      ref: "host_payBill",
      args: { billId: "b_1" },
      method: "POST",
      contentType: "application/json",
      path: "/api/vendo/apps/app_1/call",
    });
  });

  it("hands the outcome back to the caller", async () => {
    const open = await door(() => ({ status: "ok", output: { paid: true } }));
    const outcomes: ToolOutcome[] = [];
    function Payer() {
      const pay = useToolAction("host_payBill");
      return <button type="button" onClick={() => void pay.run().then((outcome) => outcomes.push(outcome))}>pay</button>;
    }
    mount(open, <Payer />);
    await press("pay");
    await waitFor(() => {
      expect(outcomes).toEqual([{ status: "ok", output: { paid: true } }]);
    });
  });

  it("REFRESHES the screen's queries after a successful action — the app author wires nothing", async () => {
    let balance = 500;
    const open = await door((call) => {
      if (call.ref === "host_payBill") {
        balance = 400;
        return { status: "ok", output: { paid: true } };
      }
      return { status: "ok", output: balance };
    });
    mount(open, <Screen />);
    await settled();
    expect(screen.getByTestId("balance").textContent).toBe("500");
    await press("pay");
    await waitFor(() => {
      expect(screen.getByTestId("balance").textContent).toBe("400");
    });
  });

  it("does NOT refresh the queries when the action did not succeed", async () => {
    const open = await door((call) =>
      call.ref === "host_payBill"
        ? { status: "blocked", reason: "paying bills is not granted" }
        : { status: "ok", output: 500 });
    mount(open, <Screen />);
    await settled();
    const readsBefore = open.calls.filter((call) => call.ref === "host_getBalance").length;
    await press("pay");
    await waitFor(() => {
      expect(screen.getByTestId("notice").textContent).toBe("blocked");
    });
    expect(open.calls.filter((call) => call.ref === "host_getBalance").length).toBe(readsBefore);
  });

  it("contains a refusal as a notice instead of crashing, and clears it on the next success", async () => {
    let granted = false;
    const open = await door((call) => {
      if (call.ref !== "host_payBill") return { status: "ok", output: 500 };
      if (!granted) {
        granted = true;
        return { status: "pending-approval", approvalId: "apr_1" };
      }
      return { status: "ok", output: { paid: true } };
    });
    mount(open, <Screen />);
    await settled();
    await press("pay");
    await waitFor(() => {
      expect(screen.getByTestId("notice").textContent).toBe("pending-approval");
    });
    await press("pay");
    await waitFor(() => {
      expect(screen.getByTestId("notice").textContent).toBe("none");
    });
  });

  it("is an error outcome, never a throw, when the door is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const open = await door(() => ({ status: "ok", output: 1 }));
    const baseUrl = open.baseUrl;
    await open.close();
    doors.splice(doors.indexOf(open), 1);
    const outcomes: ToolOutcome[] = [];
    function Payer() {
      const pay = useToolAction("host_payBill");
      return (
        <button type="button" onClick={() => void pay.run().then((outcome) => outcomes.push(outcome))}>pay</button>
      );
    }
    render(<VendoAppProvider appId="app_1" baseUrl={baseUrl}><Payer /></VendoAppProvider>);
    await press("pay");
    await waitFor(() => {
      expect(outcomes.length).toBe(1);
    });
    expect(outcomes[0]?.status).toBe("error");
    warn.mockRestore();
  });

  it("reports pending while the call is in flight", async () => {
    const pendings: boolean[] = [];
    const open = await door(() => ({ status: "ok", output: 1 }));
    mount(open, <Screen pendings={pendings} />);
    await settled();
    pendings.length = 0;
    await press("pay");
    // in flight during the round trip, and back to rest once it settles
    expect(pendings).toContain(true);
    await waitFor(() => {
      expect(screen.getByTestId("pending").textContent).toBe("false");
    });
  });

  it("serializes an unserializable payload into a contained error, not an exception", async () => {
    const open = await door(() => ({ status: "ok", output: 1 }));
    const outcomes: ToolOutcome[] = [];
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    function Payer() {
      const pay = useToolAction("host_payBill");
      return (
        <button
          type="button"
          onClick={() => void pay.run(circular as Json).then((outcome) => outcomes.push(outcome))}
        >
          pay
        </button>
      );
    }
    mount(open, <Payer />);
    await press("pay");
    await waitFor(() => {
      expect(outcomes.length).toBe(1);
    });
    expect(outcomes[0]?.status).toBe("error");
  });
});
