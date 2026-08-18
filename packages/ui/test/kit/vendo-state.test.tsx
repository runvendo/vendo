import { useKeyedState } from "../../src/kit/index.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Json } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { useVendoApp, VendoAppProvider } from "../../src/kit/app-context.js";
import { useVendoState } from "../../src/kit/vendo-state.js";

afterEach(cleanup);

function Probe({ label }: { label: string }) {
  const [tab, setTab] = useVendoState<string>("tab", "spending");
  const [count, setCount] = useVendoState<number>("count");
  return (
    <div>
      <span data-testid={`${label}-tab`}>{String(tab)}</span>
      <span data-testid={`${label}-count`}>{String(count)}</span>
      <button type="button" onClick={() => setTab("income")}>{`${label} tab`}</button>
      <button type="button" onClick={() => setCount(3)}>{`${label} count`}</button>
    </div>
  );
}

const mount = (ui: React.ReactNode) => render(<VendoAppProvider appId="app_1" baseUrl="/api/vendo">{ui}</VendoAppProvider>);

describe("useVendoState — the $state binding, in code-land", () => {
  it("reads the initial value until a key is written, then the written one", async () => {
    mount(<Probe label="a" />);
    expect(screen.getByTestId("a-tab").textContent).toBe("spending");
    // an unwritten key with no initial is undefined, exactly as a $state
    // binding resolves before anything sets it
    expect(screen.getByTestId("a-count").textContent).toBe("undefined");
    await act(async () => {
      screen.getByRole("button", { name: "a tab" }).click();
    });
    expect(screen.getByTestId("a-tab").textContent).toBe("income");
  });

  it("is ONE namespace per app instance — every reader of a key sees the write", async () => {
    mount(<><Probe label="a" /><Probe label="b" /></>);
    await act(async () => {
      screen.getByRole("button", { name: "a tab" }).click();
    });
    expect(screen.getByTestId("b-tab").textContent).toBe("income");
    await act(async () => {
      screen.getByRole("button", { name: "b count" }).click();
    });
    // a write to one key leaves the others standing
    expect(screen.getByTestId("a-count").textContent).toBe("3");
    expect(screen.getByTestId("a-tab").textContent).toBe("income");
  });

  it("gives a new app instance a fresh namespace (renderer.tsx's tree-identity rule)", async () => {
    const first = mount(<Probe label="a" />);
    await act(async () => {
      screen.getByRole("button", { name: "a tab" }).click();
    });
    expect(screen.getByTestId("a-tab").textContent).toBe("income");
    first.unmount();
    mount(<Probe label="a" />);
    expect(screen.getByTestId("a-tab").textContent).toBe("spending");
  });
});

/**
 * THE SEAM (§0): the store is the renderer's store. `useKeyedState` is the one
 * keyed-`$state` implementation, hoisted into `@vendoai/ui/kit` so
 * `StatefulTreeView` (the `.vendo` venue) and this provider (the code-land
 * venue) share it — the same move `reshape` made. Both are driven here with the
 * same writes and must hold the same state.
 */
describe("the code-land store IS the renderer's keyed store", () => {
  function DirectProbe() {
    const [state, setKey] = useKeyedState();
    return (
      <div>
        <span data-testid="direct">{JSON.stringify(state)}</span>
        <button type="button" onClick={() => setKey("tab", "income")}>direct tab</button>
        <button type="button" onClick={() => setKey("count", 3)}>direct count</button>
      </div>
    );
  }

  function ContextProbe() {
    const { state } = useVendoApp();
    const [, setTab] = useVendoState<string>("tab");
    const [, setCount] = useVendoState<number>("count");
    return (
      <div>
        <span data-testid="context">{JSON.stringify(state)}</span>
        <button type="button" onClick={() => setTab("income")}>context tab</button>
        <button type="button" onClick={() => setCount(3)}>context count</button>
      </div>
    );
  }

  it("agrees key for key after the same writes", async () => {
    render(<DirectProbe />);
    mount(<ContextProbe />);
    await act(async () => {
      screen.getByRole("button", { name: "direct tab" }).click();
      screen.getByRole("button", { name: "direct count" }).click();
      screen.getByRole("button", { name: "context tab" }).click();
      screen.getByRole("button", { name: "context count" }).click();
    });
    const direct = JSON.parse(screen.getByTestId("direct").textContent ?? "null") as Record<string, Json>;
    const context = JSON.parse(screen.getByTestId("context").textContent ?? "null") as Record<string, Json>;
    expect(context).toEqual(direct);
    expect(direct).toEqual({ tab: "income", count: 3 });
  });
});
