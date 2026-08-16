import { describe, expect, it } from "vitest";
import { SEATS, seatConflict, type Seat } from "../src/index.js";

describe("the seat map (build contract §4)", () => {
  it("is exactly the contracted seats — one per real job", () => {
    expect(SEATS).toEqual(["default", "apps", "review", "judge"]);
  });
});

describe("boot error when a harness option and a seat both set a model (§4)", () => {
  it("reports a conflict when a harness option sets a model AND models.default is set", () => {
    const conflict = seatConflict({ harnessOptionModel: "opus", seats: { default: "sonnet" } });

    expect(conflict).toBeDefined();
    // The message has to say what to remove, not just that something is wrong.
    expect(conflict).toContain("default");
  });

  it("is silent when only the harness option sets a model", () => {
    expect(seatConflict({ harnessOptionModel: "opus", seats: {} })).toBeUndefined();
  });

  it("is silent when only the seat sets a model", () => {
    expect(seatConflict({ seats: { default: "sonnet" } })).toBeUndefined();
  });

  it("is silent when the harness option collides with an unrelated seat", () => {
    // A harness naming its own model does not conflict with the judge's seat.
    expect(seatConflict({ harnessOptionModel: "opus", seats: { judge: "haiku" } })).toBeUndefined();
  });
});

describe("Seat is a closed union", () => {
  it("accepts every contracted seat name", () => {
    const seats: Seat[] = ["default", "apps", "review", "judge"];
    expect(seats.every((seat) => SEATS.includes(seat))).toBe(true);
  });
});
