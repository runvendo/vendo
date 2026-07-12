/** Composition smoke test: proves the red-team mini-umbrella wires the real
 * blocks together and a present read reaches the live fixture host app through
 * the guard-bound registry. Gated on nothing but the fixture server — no
 * external keys — so it always runs in CI.
 */
import { describe, expect, it } from "vitest";
import type { RunContext, ToolCall } from "@vendoai/core";
import { ADA, createStack, loginCookie, ownerCtx, resetFixture } from "./harness.js";

describe("redteam harness composition", () => {
  it("routes a present read through the bound registry to the fixture", async () => {
    await resetFixture();
    const stack = await createStack();
    try {
      const cookie = await loginCookie(ADA.subject);
      const ctx: RunContext = { ...ownerCtx(ADA.subject), requestHeaders: { cookie } };
      const call: ToolCall = { id: "call_smoke_read", tool: "host_invoices_list", args: {} };
      const outcome = await stack.bound.execute(call, ctx);
      expect(outcome.status).toBe("ok");
    } finally {
      await stack.close();
    }
  });
});
