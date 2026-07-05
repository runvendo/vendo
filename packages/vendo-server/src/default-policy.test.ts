import { describe, expect, it } from "vitest";
import { buildDescriptor } from "@vendoai/runtime";
import type { ToolDescriptor } from "@vendoai/runtime";
import type { VendoPrincipal } from "@vendoai/runtime";
import { defaultVendoPolicy } from "./default-policy.js";

const principal: VendoPrincipal = { userId: "user-1" };

function evaluate(toolName: string, descriptor?: Partial<ToolDescriptor>) {
  const base = buildDescriptor(toolName, {}, "caller");
  return defaultVendoPolicy.evaluate({
    toolName,
    input: {},
    descriptor: { ...base, ...descriptor },
    principal,
  });
}

describe("defaultVendoPolicy", () => {
  it("allows the engine's own render, edit, and connect tools", async () => {
    expect(await evaluate("render_view")).toBe("allow");
    // Approval-per-edit would erase the fast-edit latency win (plan review).
    expect(await evaluate("edit_view")).toBe("allow");
    expect(await evaluate("request_connect")).toBe("allow");
  });

  it("allows read-shaped automation authoring, gates the writes", async () => {
    expect(await evaluate("list_automations")).toBe("allow");
    expect(await evaluate("get_automation_runs")).toBe("allow");
    expect(await evaluate("create_automation")).toBe("approve");
    expect(await evaluate("delete_automation")).toBe("approve");
  });

  it("decides client-executed host tools from their annotations", async () => {
    expect(
      await evaluate("listAccounts", {
        executor: "client",
        annotations: { readOnlyHint: true, destructiveHint: false },
      }),
    ).toBe("allow");
    expect(
      await evaluate("createOrder", {
        executor: "client",
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    ).toBe("approve");
  });

  it("decides annotated server tools from their annotations too", async () => {
    expect(
      await evaluate("get_things", { annotations: { readOnlyHint: true } }),
    ).toBe("allow");
    expect(
      await evaluate("nuke_things", { annotations: { destructiveHint: true } }),
    ).toBe("approve");
  });

  it("uses whole-segment verb matching for Composio names, writes win", async () => {
    expect(await evaluate("GMAIL_FETCH_EMAILS")).toBe("allow");
    expect(await evaluate("GMAIL_SEND_EMAIL")).toBe("approve");
    // FIND + REPLACE — the write verb must take precedence.
    expect(await evaluate("GOOGLEDOCS_FIND_AND_REPLACE")).toBe("approve");
    // "GET" inside a word is NOT a read signal.
    expect(await evaluate("BUDGET_CREATE")).toBe("approve");
    // A read verb only counts in the VERB position: GMAIL_MARK_AS_READ mutates
    // (verb MARK), so the trailing READ must NOT auto-allow it.
    expect(await evaluate("GMAIL_MARK_AS_READ")).toBe("approve");
    expect(await evaluate("SLACK_ARCHIVE_CHANNEL")).toBe("approve");
  });

  it("fail-safe: unknown tools require approval", async () => {
    expect(await evaluate("mystery_tool")).toBe("approve");
  });
});
