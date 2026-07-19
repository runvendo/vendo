import { describe, expect, it } from "vitest";
import { memoryStore } from "./testing/index.js";
import { APP_TOKEN_COLLECTION, createAppTokens } from "./app-token.js";

const APP = "app_box_1";
const OWNER = "user_ada";

describe("per-app box tokens (execution-v2 skin contract)", () => {
  it("mints a bearer that verifies back to its app and owner", async () => {
    const store = memoryStore();
    const tokens = createAppTokens(store);
    const token = await tokens.mint(APP, OWNER);
    expect(token).toMatch(/^vat_[0-9a-f]{64}$/);
    expect(await tokens.verify(token)).toEqual({ appId: APP, subject: OWNER });
  });

  it("stores the token HASH, never the token", async () => {
    const store = memoryStore();
    const tokens = createAppTokens(store);
    const token = await tokens.mint(APP, OWNER);
    const { records } = await store.records(APP_TOKEN_COLLECTION).list();
    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(token.slice("vat_".length));
  });

  it("rejects a forged, malformed, or unknown token", async () => {
    const store = memoryStore();
    const tokens = createAppTokens(store);
    await tokens.mint(APP, OWNER);
    expect(await tokens.verify("")).toBeNull();
    expect(await tokens.verify("vat_" + "0".repeat(64))).toBeNull();
    expect(await tokens.verify("Bearer whatever")).toBeNull();
  });

  it("re-minting rotates: the previous token stops verifying", async () => {
    const store = memoryStore();
    const tokens = createAppTokens(store);
    const first = await tokens.mint(APP, OWNER);
    const second = await tokens.mint(APP, OWNER);
    expect(await tokens.verify(first)).toBeNull();
    expect(await tokens.verify(second)).toEqual({ appId: APP, subject: OWNER });
  });

  it("revoke(appId) kills the app's token without touching another app's", async () => {
    const store = memoryStore();
    const tokens = createAppTokens(store);
    const mine = await tokens.mint(APP, OWNER);
    const other = await tokens.mint("app_box_2", "user_bob");
    await tokens.revoke(APP);
    expect(await tokens.verify(mine)).toBeNull();
    expect(await tokens.verify(other)).toEqual({ appId: "app_box_2", subject: "user_bob" });
  });
});
