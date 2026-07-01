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
    for (const name of ["render_ui", "render_view", "get_transactions", "set_rule"]) {
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
});
