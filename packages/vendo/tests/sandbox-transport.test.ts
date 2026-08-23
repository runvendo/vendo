/**
 * Every console ANSWER this adapter dislikes already becomes a named VendoError
 * (raiseSandboxError). A console it never reached did not: `fetchImpl` threw,
 * and undici's throw for a dead connection is a bare `TypeError: fetch failed`
 * whose only detail is on the cause. Raw, it reaches a caller as three words
 * that name neither Vendo nor the call, and the log seam above drops the cause.
 */
import { VendoError } from "@vendoai/core";
import { expect, test } from "vitest";
import { cloudSandbox } from "../src/sandbox.js";

test("a console this adapter cannot reach is a named failure that keeps the cause", async () => {
  const cause = new Error("ECONNRESET");
  const adapter = cloudSandbox({
    apiKey: "vnd_secret",
    baseUrl: "https://cloud.test",
    fetch: (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause });
    }) as unknown as typeof fetch,
  });

  const thrown = await adapter.create({ env: {} }).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(VendoError);
  expect((thrown as VendoError).code).toBe("sandbox-unavailable");
  expect((thrown as VendoError).message).toMatch(/Vendo Cloud sandbox/);
  // The whole chain, so an operator can tell a refused connect from a dead
  // socket: undici's three words on top, the real reason underneath.
  const detail = (thrown as VendoError).detail as { cause: Error };
  expect(detail.cause).toBeInstanceOf(TypeError);
  expect(detail.cause.cause).toBe(cause);
});
