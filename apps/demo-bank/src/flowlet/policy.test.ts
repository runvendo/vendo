import { describe, it, expect } from "vitest";
import { demoPolicy } from "./policy";
import type { PolicyContext } from "@flowlet/agent";

const ctx = (toolName: string): PolicyContext => ({
  toolName,
  input: {},
  descriptor: { name: toolName, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
  principal: { userId: "demo" },
});

describe("demoPolicy", () => {
  it("allows the render tools and demo read/rule tools", async () => {
    for (const name of ["render_view", "request_connect", "get_transactions", "set_rule"]) {
      expect(await demoPolicy.evaluate(ctx(name))).toBe("allow");
    }
  });
  it("allows read-shaped Composio tools", async () => {
    expect(await demoPolicy.evaluate(ctx("GMAIL_FETCH_EMAILS"))).toBe("allow");
    expect(await demoPolicy.evaluate(ctx("SLACK_LIST_CHANNELS"))).toBe("allow");
  });
  it("requires approval for write-shaped external tools", async () => {
    expect(await demoPolicy.evaluate(ctx("GMAIL_SEND_EMAIL"))).toBe("approve");
    expect(await demoPolicy.evaluate(ctx("SLACK_SEND_MESSAGE"))).toBe("approve");
  });
  it("requires approval for unknown tools (fail-safe)", async () => {
    expect(await demoPolicy.evaluate(ctx("SOME_NEW_TOOL"))).toBe("approve");
  });
  it("gates write/destructive tools whose name merely contains a read word", async () => {
    for (const name of ["GOOGLEDOCS_FIND_AND_REPLACE", "BUDGET_CREATE", "PLAYLIST_ADD_TRACK", "TARGET_DELETE"]) {
      expect(await demoPolicy.evaluate(ctx(name))).toBe("approve");
    }
  });

  describe("host-API tools (client-executed) are decided by their annotations", () => {
    const hostCtx = (
      toolName: string,
      annotations: Record<string, boolean>,
    ): PolicyContext => ({
      toolName,
      input: {},
      descriptor: {
        name: toolName,
        source: "caller",
        annotations,
        hasExecute: false,
        kind: "function",
        executor: "client",
      },
      principal: { userId: "demo" },
    });

    it("auto-allows read-only host calls", async () => {
      expect(
        await demoPolicy.evaluate(hostCtx("listAccounts", { readOnlyHint: true })),
      ).toBe("allow");
    });

    it("gates mutating host calls", async () => {
      expect(
        await demoPolicy.evaluate(hostCtx("createOrder", { readOnlyHint: false })),
      ).toBe("approve");
    });

    it("gates destructive host calls", async () => {
      expect(
        await demoPolicy.evaluate(
          hostCtx("deletePayee", { readOnlyHint: false, destructiveHint: true }),
        ),
      ).toBe("approve");
    });

    it("gates unhinted host calls (fail-safe)", async () => {
      expect(await demoPolicy.evaluate(hostCtx("mystery", {}))).toBe("approve");
    });
  });
});
