import { act, render, screen } from "@testing-library/react";
import type { Json } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { useKeyedState } from "../../src/kit/state.js";

/**
 * The keyed `$state` store the renderer and the code-land provider share. The renderer
 * suite only ever writes ONE key, so these are the semantics that suite cannot
 * see: composition across keys.
 */
function Probe() {
  const [state, setKey] = useKeyedState();
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
});
