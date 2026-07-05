import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@vendoai/core";
import { InProcessExecutor } from "./in-process-executor";

const context: ExecutionContext = { principal: { tenantId: "t1", subject: "u1" } };

describe("InProcessExecutor", () => {
  it("runs a registered tool and returns its outcome", async () => {
    const executor = new InProcessExecutor({
      echo: async (input) => ({ ok: true, result: input }),
    });
    const outcome = await executor.execute(
      { toolCallId: "c1", toolName: "echo", input: { a: 1 } },
      context,
    );
    expect(outcome).toEqual({ ok: true, result: { a: 1 } });
  });

  it("preserves ok:true with an undefined result (never mis-narrows as error)", async () => {
    const executor = new InProcessExecutor({
      noop: async () => ({ ok: true, result: undefined }),
    });
    const outcome = await executor.execute(
      { toolCallId: "c1", toolName: "noop", input: {} },
      context,
    );
    expect(outcome.ok).toBe(true);
  });

  it("fails closed on an unknown tool", async () => {
    const executor = new InProcessExecutor({});
    const outcome = await executor.execute(
      { toolCallId: "c1", toolName: "missing", input: {} },
      context,
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: "unknown_tool", message: 'tool "missing" is not registered' },
    });
  });

  it("converts a thrown error into an error outcome (one crashed call, not a crashed host)", async () => {
    const executor = new InProcessExecutor({
      boom: async () => {
        throw new Error("kaboom");
      },
    });
    const outcome = await executor.execute(
      { toolCallId: "c1", toolName: "boom", input: {} },
      context,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("tool_error");
      expect(outcome.error.message).toContain("kaboom");
    }
  });

  it("passes the execution context (grant, signal) through to the tool", async () => {
    let seen: ExecutionContext | undefined;
    const executor = new InProcessExecutor({
      probe: async (_input, ctx) => {
        seen = ctx;
        return { ok: true, result: null };
      },
    });
    const grantCtx: ExecutionContext = {
      principal: context.principal,
      grant: { token: "embedded:t1:u1:auto-1", expiresAt: "2026-07-02T00:15:00.000Z", scopes: [] },
    };
    await executor.execute({ toolCallId: "c1", toolName: "probe", input: {} }, grantCtx);
    expect(seen?.grant?.token).toBe("embedded:t1:u1:auto-1");
  });
});
