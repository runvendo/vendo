import { describe, expect, it } from "vitest";
import { createAppData } from "../app-data.js";
import { memoryStore } from "../testing/index.js";

// Red-team suite for per-app state isolation (06-apps §6).
// App state is keyed by the TRUSTED appId (derived from the run token / ctx in the
// proxy, never from a request body). One app's read must never surface another app's
// state, and one user's read must never surface another user's state for the same app.
// This complements proxy-escalation.test.ts (which proves the ctx.appId is trusted);
// here we prove the app-data layer itself keys on that appId with no cross-bleed.

describe("app-data isolation", () => {
  it("keeps state for app A and app B independent under the same subject", async () => {
    const data = createAppData(memoryStore());
    await data.setState("app_A", "user_ada", { secret: "A-data" });
    await data.setState("app_B", "user_ada", { secret: "B-data" });

    // A read scoped to app A can only ever see app A's data.
    expect(await data.getState("app_A", "user_ada")).toEqual({ secret: "A-data" });
    expect(await data.getState("app_B", "user_ada")).toEqual({ secret: "B-data" });

    // There is no state for an app the subject never wrote.
    expect(await data.getState("app_C", "user_ada")).toBeNull();
  });

  it("keeps the same app's state independent across subjects", async () => {
    const data = createAppData(memoryStore());
    await data.setState("app_A", "user_ada", { note: "adas" });
    await data.setState("app_A", "user_grace", { note: "graces" });

    expect(await data.getState("app_A", "user_ada")).toEqual({ note: "adas" });
    expect(await data.getState("app_A", "user_grace")).toEqual({ note: "graces" });
    // A subject who never wrote sees nothing — no cross-user read.
    expect(await data.getState("app_A", "user_mallory")).toBeNull();
  });

  it("does not let one app overwrite another app's state via a shared subject", async () => {
    const data = createAppData(memoryStore());
    await data.setState("app_A", "user_ada", { v: 1 });
    await data.setState("app_B", "user_ada", { v: 2 });
    // Rewriting B must not touch A.
    await data.setState("app_B", "user_ada", { v: 3 });
    expect(await data.getState("app_A", "user_ada")).toEqual({ v: 1 });
    expect(await data.getState("app_B", "user_ada")).toEqual({ v: 3 });
  });
});
