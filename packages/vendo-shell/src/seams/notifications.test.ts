import { describe, expect, it } from "vitest";
import { createLocalNotifications, type AutomationNotice } from "./notifications";

describe("createLocalNotifications", () => {
  it("serves seeded notices since a cursor and resumes as stale by default", async () => {
    const seed: AutomationNotice[] = [
      { cursor: 1, kind: "completed", runId: "r1", summary: "done", text: "Automation done." },
      {
        cursor: 2,
        kind: "approval-required",
        runId: "r2",
        stepId: "s1",
        summary: "wants to send",
        text: "Needs approval.",
      },
    ];
    const local = createLocalNotifications(seed);
    expect(await local.listSince(0)).toEqual(seed);
    expect(await local.listSince(1)).toEqual([seed[1]]);
    expect(await local.resume("r2", true)).toBe("stale");
  });

  it("defaults to an empty feed", async () => {
    expect(await createLocalNotifications().listSince(0)).toEqual([]);
  });
});
