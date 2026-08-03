import { describe, expect, it } from "vitest";
import { SEATS, migrateModelSeats, seatConflict, type Seat } from "./index.js";

describe("the seat map (build contract §4)", () => {
  it("is exactly the five contracted seats", () => {
    expect(SEATS).toEqual(["default", "reviewer", "judge", "fill", "verifier"]);
  });

  it("migrates today's slot names onto seats", () => {
    expect(migrateModelSeats({ agent: "a", paint: "p", judge: "j" })).toEqual({
      default: "a",
      fill: "p",
      judge: "j",
    });
  });

  it("maps knowledgeVerifier to its own `verifier` seat", () => {
    // This test previously asserted the FOLD into `default`. The contract
    // amendment retracted it: the fold's premise (no independent consumer) was
    // false, and it silently repointed the model that answers users whenever a
    // host set only this knob. Covered in depth in verifier-seat.test.ts.
    expect(migrateModelSeats({ knowledgeVerifier: "kv" })).toEqual({ verifier: "kv" });
  });

  it("keeps the agent model and the knowledge check independent", () => {
    expect(migrateModelSeats({ agent: "a", knowledgeVerifier: "kv" }))
      .toEqual({ default: "a", verifier: "kv" });
  });

  it("carries a seat already written in the new vocabulary straight through", () => {
    expect(migrateModelSeats({ default: "d", reviewer: "r" })).toEqual({ default: "d", reviewer: "r" });
  });

  it("returns nothing for an empty config rather than inventing seats", () => {
    expect(migrateModelSeats({})).toEqual({});
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
    const seats: Seat[] = ["default", "reviewer", "judge", "fill"];
    expect(seats.every((seat) => SEATS.includes(seat))).toBe(true);
  });
});
