import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Json, ToolOutcome } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VendoAppProvider } from "../../src/kit/app-context.js";
import { useToolQuery } from "../../src/kit/query.js";
import { startDoor, type Door } from "./wire-fixture.js";

afterEach(cleanup);

const doors: Door[] = [];
afterEach(async () => {
  await Promise.all(doors.splice(0).map((door) => door.close()));
});

const door = async (answer: (call: { ref: string; args: Json }) => ToolOutcome): Promise<Door> => {
  const started = await startDoor(answer);
  doors.push(started);
  return started;
};

function Spending({ args }: { args?: Json }) {
  const spending = useToolQuery("host_listSpending", args);
  return (
    <div>
      <span data-testid="data">{JSON.stringify(spending.data)}</span>
      <span data-testid="loading">{String(spending.loading)}</span>
      <span data-testid="unavailable">{String(spending.dataUnavailable)}</span>
      <span data-testid="status">{spending.outcome?.status ?? "none"}</span>
      <button type="button" onClick={() => void spending.refetch()}>refetch</button>
    </div>
  );
}

const mount = (open: Door, ui: React.ReactNode) =>
  render(<VendoAppProvider appId="app_1" baseUrl={open.baseUrl}>{ui}</VendoAppProvider>);

const settled = async () => {
  await waitFor(() => {
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });
};

const read = () => ({
  data: JSON.parse(screen.getByTestId("data").textContent || "null") as Json,
  unavailable: screen.getByTestId("unavailable").textContent,
  status: screen.getByTestId("status").textContent,
});

describe("useToolQuery — the guarded read, over the door that already exists", () => {
  it("reads through POST <base>/apps/:appId/call with the wire's own body", async () => {
    const open = await door(() => ({ status: "ok", output: [{ merchant: "Blue Bottle", cents: 750 }] }));
    mount(open, <Spending args={{ month: "2026-08" }} />);
    await settled();
    expect(read().data).toEqual([{ merchant: "Blue Bottle", cents: 750 }]);
    expect(read().unavailable).toBe("false");
    expect(open.calls).toEqual([{
      appId: "app_1",
      ref: "host_listSpending",
      args: { month: "2026-08" },
      method: "POST",
      contentType: "application/json",
      path: "/api/vendo/apps/app_1/call",
    }]);
  });

  it("treats an EMPTY answer as an answer — empty is not unavailable", async () => {
    const open = await door(() => ({ status: "ok", output: [] }));
    mount(open, <Spending />);
    await settled();
    expect(read().data).toEqual([]);
    expect(read().unavailable).toBe("false");
  });

  it("contributes NO data and flags unavailable for every non-ok outcome", async () => {
    const outcomes: ToolOutcome[] = [
      { status: "error", error: { code: "upstream", message: "the bank said no" } },
      { status: "blocked", reason: "this tool is not granted" },
      { status: "pending-approval", approvalId: "apr_1" },
      { status: "connect-required", connect: { connector: "plaid", toolkit: "plaid", message: "connect first" } },
    ];
    for (const outcome of outcomes) {
      const open = await door(() => outcome);
      const view = mount(open, <Spending />);
      await settled();
      // a failed load must never read as "you have no spending"
      expect(read().data).toBeNull();
      expect(read().unavailable).toBe("true");
      expect(read().status).toBe(outcome.status);
      view.unmount();
    }
  });

  it("is an unavailable read, not an exception, when the door is unreachable", async () => {
    const open = await door(() => ({ status: "ok", output: 1 }));
    const baseUrl = open.baseUrl;
    await open.close();
    doors.splice(doors.indexOf(open), 1);
    render(
      <VendoAppProvider appId="app_1" baseUrl={baseUrl}>
        <Spending />
      </VendoAppProvider>,
    );
    await settled();
    expect(read().data).toBeNull();
    expect(read().unavailable).toBe("true");
    expect(read().status).toBe("error");
  });

  it("is an unavailable read when the wire answers its error envelope", async () => {
    const open = await door(() => {
      throw new Error("app not found: app_1");
    });
    mount(open, <Spending />);
    await settled();
    expect(read().unavailable).toBe("true");
    expect(read().status).toBe("error");
  });

  it("reports each distinct miss ONCE, the way the server-side resolver does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const open = await door(() => ({ status: "blocked", reason: "not granted" }));
    mount(open, <Spending />);
    await settled();
    await act(async () => {
      screen.getByRole("button", { name: "refetch" }).click();
    });
    await waitFor(() => {
      expect(open.calls.length).toBe(2);
    });
    const mine = warn.mock.calls.filter(([message]) => String(message).includes("host_listSpending"));
    expect(mine.length).toBe(1);
    expect(String(mine[0]?.[0])).toContain("renders empty");
    warn.mockRestore();
  });

  it("refetches on demand", async () => {
    let cents = 750;
    const open = await door(() => ({ status: "ok", output: { cents } }));
    mount(open, <Spending />);
    await settled();
    expect(read().data).toEqual({ cents: 750 });
    cents = 900;
    await act(async () => {
      screen.getByRole("button", { name: "refetch" }).click();
    });
    await waitFor(() => {
      expect(read().data).toEqual({ cents: 900 });
    });
  });

  it("re-reads when the args change, and only then", async () => {
    const open = await door((call) => ({ status: "ok", output: call.args }));
    const view = mount(open, <Spending args={{ month: "2026-08" }} />);
    await settled();
    // the same args, a new object identity: NOT a new read
    view.rerender(
      <VendoAppProvider appId="app_1" baseUrl={open.baseUrl}>
        <Spending args={{ month: "2026-08" }} />
      </VendoAppProvider>,
    );
    await settled();
    expect(open.calls.length).toBe(1);
    view.rerender(
      <VendoAppProvider appId="app_1" baseUrl={open.baseUrl}>
        <Spending args={{ month: "2026-09" }} />
      </VendoAppProvider>,
    );
    await waitFor(() => {
      expect(read().data).toEqual({ month: "2026-09" });
    });
    expect(open.calls.length).toBe(2);
  });

  it("never calls a door it has no app id for — it reports unavailable instead", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const open = await door(() => ({ status: "ok", output: 1 }));
    render(
      <VendoAppProvider appId="" baseUrl={open.baseUrl}>
        <Spending />
      </VendoAppProvider>,
    );
    await settled();
    expect(read().unavailable).toBe("true");
    expect(open.calls.length).toBe(0);
    expect(warn.mock.calls.some(([message]) => String(message).includes("VendoAppProvider"))).toBe(true);
    warn.mockRestore();
  });
});
