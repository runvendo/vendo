import { act, render, screen } from "@testing-library/react";
import type { Json } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { useKeyedState } from "../../src/kit/state.js";

/**
 * The keyed `$state` store the renderer and `@vendoai/kit` share. The renderer
 * suite only ever writes ONE key, so these are the semantics that suite cannot
 * see: composition across keys, and the persistence hook's payload.
 */
function Probe({ onChange }: { onChange?: (state: Record<string, Json>) => void }) {
  const [state, setKey] = useKeyedState(onChange);
  return (
    <div>
      <span data-testid="state">{JSON.stringify(state)}</span>
      <button type="button" onClick={() => setKey("tab", "income")}>tab</button>
      <button type="button" onClick={() => setKey("page", 2)}>page</button>
      <button type="button" onClick={() => setKey("tab", "spending")}>retab</button>
    </div>
  );
}

const held = () => JSON.parse(screen.getByTestId("state").textContent ?? "null") as Record<string, Json>;
const press = async (name: string) => {
  await act(async () => {
    screen.getByRole("button", { name }).click();
  });
};

describe("useKeyedState", () => {
  it("starts empty — an unwritten key is absent, not null", () => {
    render(<Probe />);
    expect(held()).toEqual({});
  });

  it("composes across keys: a write leaves every other key standing", async () => {
    render(<Probe />);
    await press("tab");
    await press("page");
    expect(held()).toEqual({ tab: "income", page: 2 });
  });

  it("takes the last write for a key", async () => {
    render(<Probe />);
    await press("tab");
    await press("retab");
    expect(held()).toEqual({ tab: "spending" });
  });

  it("composes two writes made in the SAME tick (why the store keeps a ref)", async () => {
    render(<Probe />);
    await act(async () => {
      screen.getByRole("button", { name: "tab" }).click();
      screen.getByRole("button", { name: "page" }).click();
    });
    expect(held()).toEqual({ tab: "income", page: 2 });
  });

  it("hands the persistence hook the whole next state", async () => {
    const onChange = vi.fn();
    render(<Probe onChange={onChange} />);
    await press("tab");
    await press("page");
    expect(onChange.mock.calls.map(([state]) => state)).toEqual([
      { tab: "income" },
      { tab: "income", page: 2 },
    ]);
  });
});
