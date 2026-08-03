import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import { appAccess } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { hostedStore } from "./hosted-store.js";
import { fakeConsole } from "./hosted-store.test-util.js";

/**
 * Build contract §9.2 — the principal grammar belongs to the DOOR.
 *
 * `appAccess(store)` is one implementation over the record adapter, and the
 * adapter rule says behaviour may never depend on which store is wired. It did:
 * the grammar guard lived in the local engine's routing layer
 * (`packages/store/src/routing.ts` `parseAppGrantData`), and the hosted store
 * posts straight to the console, so the SAME share was refused on Postgres and
 * accepted on Vendo Cloud's own default. The refusal is proven here on the shape
 * that had no coverage at all.
 */

const doc = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Team dashboard",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "ok" } }],
  },
});

const ctxFor = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
});

const hosted = () => {
  const console_ = fakeConsole();
  const store = hostedStore({
    apiKey: "vnd_secret",
    baseUrl: "https://cloud.test",
    fetch: console_.handler as unknown as typeof fetch,
  });
  return { console_, store };
};

const grantPuts = (console_: ReturnType<typeof fakeConsole>): unknown[] =>
  console_.requests
    .filter((entry) => entry.url.endsWith("/records/vendo_app_grants/put"))
    .map((entry) => entry.json);

describe("§9.2 — an unparseable principal is refused on the HOSTED store too", () => {
  it("refuses before the write, so the console never sees a grant that matches nobody", async () => {
    // What the Share dialog used to send: whatever the person typed, encoded
    // verbatim. `user:Mia` parses; a bare name does not, and a row that cannot
    // be parsed can never match anyone — the app had already been moved into
    // the team by the time it landed.
    const { console_, store } = hosted();
    await store.records("vendo_apps").put({
      id: "app_1",
      data: { subject: "dana", enabled: false, doc: doc("app_1") },
      refs: { subject: "dana" },
    });

    await expect(appAccess(store).grant(ctxFor("dana"), "app_1" as AppId, "Mia", "viewer"))
      .rejects.toMatchObject({ code: "validation" });
    expect(grantPuts(console_)).toEqual([]);
  });

  it("still writes a WELL-FORMED grant through the same door", async () => {
    // The red half of the guard: it refuses the malformed one and nothing else.
    const { console_, store } = hosted();
    await store.records("vendo_apps").put({
      id: "app_2",
      data: { subject: "acme", enabled: false, doc: doc("app_2") },
      refs: { subject: "acme" },
    });
    const admin: RunContext = { ...ctxFor("dana"), memberships: [{ org: "acme", admin: true }] };

    await appAccess(store).grant(admin, "app_2" as AppId, "user:mia", "editor");
    expect(grantPuts(console_)).toHaveLength(1);
    expect(await appAccess(store).levelFor(ctxFor("mia"), "app_2" as AppId)).toBe("editor");
  });
});
