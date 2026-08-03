import type { AppId } from "@vendoai/core";
import type { AppMount } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPromoteApp, type PromoteHalves } from "./promote-app.js";

/**
 * Build contract §9.5 — the rollback rule, over fakes, because the interleavings
 * that matter (a lost race, a rollback that itself collides) are not reachable
 * on demand through the wire. The end-to-end proof that they DO happen is
 * orgs-e8.test.ts's two-simultaneous-promotes case.
 */

const APP = "app_seam" as AppId;

interface Recorded { moves: Array<{ from: AppMount; to: AppMount }> }

const halvesFor = (over: {
  /** What the row says when the rollback decision is made. */
  subjectAfter: string | null;
  flip?: () => Promise<void>;
  reverseMove?: () => Promise<void>;
}): PromoteHalves & Recorded => {
  const moves: Array<{ from: AppMount; to: AppMount }> = [];
  return {
    moves,
    rows: {
      async get() {
        return over.subjectAfter === null ? null : { subject: over.subjectAfter };
      },
      promote: over.flip ?? (async () => undefined),
    },
    workspace: {
      async moveApp(_appId, from, to) {
        moves.push({ from, to });
        if (moves.length > 1 && over.reverseMove !== undefined) await over.reverseMove();
        return 1;
      },
    },
  };
};

afterEach(() => vi.restoreAllMocks());

describe("§9.5 — promote moves documents first and flips the row last", () => {
  it("moves the documents into the org, then flips the row", async () => {
    const halves = halvesFor({ subjectAfter: "dana" });
    await createPromoteApp(halves)(APP, "dana", "maple");
    expect(halves.moves).toEqual([
      { from: { kind: "user", subject: "dana" }, to: { kind: "org", org: "maple" } },
    ]);
  });

  it("puts the documents back when the flip fails and the app is still THIS caller's", async () => {
    const halves = halvesFor({
      subjectAfter: "dana",
      flip: async () => { throw new Error("transient"); },
    });
    await expect(createPromoteApp(halves)(APP, "dana", "maple")).rejects.toThrow("transient");
    expect(halves.moves).toEqual([
      { from: { kind: "user", subject: "dana" }, to: { kind: "org", org: "maple" } },
      { from: { kind: "org", org: "maple" }, to: { kind: "user", subject: "dana" } },
    ]);
  });

  it("undoes NOTHING when a concurrent promote already flipped the row", async () => {
    // The loser's rollback would move the WINNER's documents back out of the
    // org, leaving one app half-moved and invisible to its own owner.
    const halves = halvesFor({
      subjectAfter: "maple",
      flip: async () => { throw new Error("app app_seam belongs to another subject"); },
    });
    await expect(createPromoteApp(halves)(APP, "dana", "maple"))
      .rejects.toThrow("belongs to another subject");
    expect(halves.moves).toHaveLength(1);
  });

  it("undoes nothing when the row is gone entirely", async () => {
    const halves = halvesFor({
      subjectAfter: null,
      flip: async () => { throw new Error("deleted mid-promote"); },
    });
    await expect(createPromoteApp(halves)(APP, "dana", "maple")).rejects.toThrow("deleted mid-promote");
    expect(halves.moves).toHaveLength(1);
  });

  it("surfaces the ORIGINAL cause when the rollback itself fails, and says so loudly", async () => {
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const halves = halvesFor({
      subjectAfter: "dana",
      flip: async () => { throw new Error("the flip's own reason"); },
      reverseMove: async () => { throw new Error("the rollback's reason"); },
    });

    // The caller is told what actually went wrong, not what went wrong while
    // cleaning up — the rollback's error would send them to fix the wrong thing.
    await expect(createPromoteApp(halves)(APP, "dana", "maple"))
      .rejects.toThrow("the flip's own reason");

    // ...and the state that now needs a human is loud, with both reasons and
    // where the documents actually are.
    expect(loud).toHaveBeenCalledTimes(1);
    const line = loud.mock.calls[0]![0] as string;
    expect(line).toContain("/orgs/maple/apps/app_seam/");
    expect(line).toContain("the flip's own reason");
    expect(line).toContain("the rollback's reason");
    expect(line).toContain("the row still says dana");
  });
});
