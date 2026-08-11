import { VENDO_APP_FORMAT } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import type { AppDocument } from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createAppData } from "../../src/server/persistence/app-data.js";
import { memoryStore } from "../../src/server/testing/memory-store.js";

// Red-team suite for per-app state isolation (06-apps §6).
// App state is keyed by the TRUSTED appId (derived from the run token / ctx in the
// proxy, never from a request body). One app's read must never surface another app's
// state, and one user's read must never surface another user's state for the same app.
// This complements proxy-escalation.test.ts (which proves the ctx.appId is trusted);
// here we prove the app-data layer itself keys on that appId with no cross-bleed.
// Declared collections go further: the owner rides in the target, so a row is stamped
// with the live caller and a list is scoped to them — a cross-owner read is not
// forbidden, it is unexpressible. These cases run against core's reference StoreOps,
// the same one the conformance suite holds the real backends to.

const appData = () => createAppData({ ops: memoryStoreOps(), store: memoryStore() });

/** One app, one records collection, one files collection — `createAppData` reads
 *  only `id` and `storage`, and both owners below share all three. */
const app: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_shared",
  name: "Shared Notes",
  storage: {
    // `subject` is DECLARED on purpose: it clears the runtime's own undeclared-ref
    // guard, so the spoofing case below lands on the store's refusal and not on a
    // shallower one that would pass whether or not the family stamps the owner.
    notes: { about: "Notes a user writes", refs: { subject: "host.user" } },
    attachments: { about: "Files a user attaches", kind: "files" },
  },
};

describe("app-data isolation", () => {
  it("keeps state for app A and app B independent under the same subject", async () => {
    const data = appData();
    await data.setState("app_A", "user_ada", { secret: "A-data" });
    await data.setState("app_B", "user_ada", { secret: "B-data" });

    // A read scoped to app A can only ever see app A's data.
    expect(await data.getState("app_A", "user_ada")).toEqual({ secret: "A-data" });
    expect(await data.getState("app_B", "user_ada")).toEqual({ secret: "B-data" });

    // There is no state for an app the subject never wrote.
    expect(await data.getState("app_C", "user_ada")).toBeNull();
  });

  it("keeps the same app's state independent across subjects", async () => {
    const data = appData();
    await data.setState("app_A", "user_ada", { note: "adas" });
    await data.setState("app_A", "user_grace", { note: "graces" });

    expect(await data.getState("app_A", "user_ada")).toEqual({ note: "adas" });
    expect(await data.getState("app_A", "user_grace")).toEqual({ note: "graces" });
    // A subject who never wrote sees nothing — no cross-user read.
    expect(await data.getState("app_A", "user_mallory")).toBeNull();
  });

  it("does not let one app overwrite another app's state via a shared subject", async () => {
    const data = appData();
    await data.setState("app_A", "user_ada", { v: 1 });
    await data.setState("app_B", "user_ada", { v: 2 });
    // Rewriting B must not touch A.
    await data.setState("app_B", "user_ada", { v: 3 });
    expect(await data.getState("app_A", "user_ada")).toEqual({ v: 1 });
    expect(await data.getState("app_B", "user_ada")).toEqual({ v: 3 });
  });

  it("lists only the caller's own rows when two owners share an app collection", async () => {
    const data = appData();
    await data.records(app, "notes", "user_ada").put({ id: "note_ada", data: { body: "adas" } });
    await data.records(app, "notes", "user_grace").put({ id: "note_grace", data: { body: "graces" } });

    const ada = await data.records(app, "notes", "user_ada").list();
    const grace = await data.records(app, "notes", "user_grace").list();
    expect(ada.records.map((record) => record.id)).toEqual(["note_ada"]);
    expect(grace.records.map((record) => record.id)).toEqual(["note_grace"]);

    // An id another owner already holds is refused, never quietly taken over.
    await expect(data.records(app, "notes", "user_grace").put({
      id: "note_ada",
      data: { body: "stolen" },
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("returns null for a get of another owner's row in the same collection", async () => {
    const data = appData();
    await data.records(app, "notes", "user_ada").put({ id: "secret", data: { body: "adas secret" } });

    expect(await data.records(app, "notes", "user_grace").get("secret")).toBeNull();
    // The owner's own read lands, so the null above cannot come from a wrong collection or id.
    expect(await data.records(app, "notes", "user_ada").get("secret")).toMatchObject({
      id: "secret",
      data: { body: "adas secret" },
    });
  });

  it("makes a delete of another owner's row a no-op", async () => {
    const data = appData();
    await data.records(app, "notes", "user_ada").put({ id: "keep", data: { body: "adas" } });

    await data.records(app, "notes", "user_grace").delete("keep");
    expect(await data.records(app, "notes", "user_ada").get("keep")).toMatchObject({ id: "keep" });

    // The same call from the owner does delete, so "delete never works" cannot pass here.
    await data.records(app, "notes", "user_ada").delete("keep");
    expect(await data.records(app, "notes", "user_ada").get("keep")).toBeNull();
  });

  it("refuses a caller-supplied refs.subject instead of stamping it", async () => {
    const data = appData();

    await expect(data.records(app, "notes", "user_ada").put({
      id: "spoofed",
      data: { body: "for grace" },
      refs: { subject: "user_grace" },
    })).rejects.toMatchObject({ code: "validation" });

    expect(await data.records(app, "notes", "user_ada").get("spoofed")).toBeNull();
    expect(await data.records(app, "notes", "user_grace").get("spoofed")).toBeNull();
  });

  it("scopes a file collection to its owner for get and list alike", async () => {
    const data = appData();
    await data.blobs(app, "attachments", "user_ada").put(
      "receipt.txt",
      new TextEncoder().encode("adas receipt"),
    );

    expect(await data.blobs(app, "attachments", "user_grace").get("receipt.txt")).toBeNull();
    expect(await data.blobs(app, "attachments", "user_grace").list()).toEqual([]);
    expect(await data.blobs(app, "attachments", "user_ada").get("receipt.txt")).not.toBeNull();
    expect(await data.blobs(app, "attachments", "user_ada").list()).toEqual(["receipt.txt"]);
  });
});
