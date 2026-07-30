import { vendoAutomationPartSchema, type ToolDescriptor } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
} from "./test-helpers.js";

// stream-parts VendoAutomationPart — an edit that rode the escalation ladder
// to an automation must land in the thread as a `data-vendo-automation` part
// (the AutomationCard), not just prose. The contract under test: the part is
// emitted from the edit tool's ok output by NAME (never by duck-typing an
// arbitrary tool's output — the same 01 §16 rule as the view part).

const editDescriptor: ToolDescriptor = {
  name: "vendo_apps_edit",
  description: "Edit a Vendo app.",
  inputSchema: {
    type: "object",
    properties: { appId: { type: "string" }, instruction: { type: "string" } },
    required: ["appId", "instruction"],
    additionalProperties: false,
  },
  risk: "read",
};

const echoDescriptor: ToolDescriptor = {
  name: "echo",
  description: "Return the supplied value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  risk: "read",
};

const TRIGGER = {
  on: { kind: "schedule", every: "1d" },
  run: { kind: "agentic", prompt: "check the balance" },
};

const AUTOMATED_EDIT_OUTPUT = {
  app: { id: "app_auto_1", name: "Overdraft alert", description: "Emails you before an overdraft." },
  automation: {
    mode: "agentic",
    trigger: TRIGGER,
    enabled: true,
    pendingGrants: [{ id: "apr_1" }, { id: "apr_2" }],
  },
};

describe("automation card part (data-vendo-automation)", () => {
  it("an edit that armed an automation streams the card part", async () => {
    const guard = testGuard({});
    const registry = boundRegistry({
      vendo_apps_edit: {
        descriptor: editDescriptor,
        execute: () => AUTOMATED_EDIT_OUTPUT,
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn("vendo_apps_edit", { appId: "app_auto_1", instruction: "alert me before I overdraft" }, "call_edit_1"),
      textTurn("Armed the overdraft alert.", "text_edit_1"),
    ]);
    const agent = createAgent({ model, tools: registry, guard });

    const response = await agent.stream({
      threadId: "thr_automation_part",
      message: userMessage("user_automation_part", "alert me before I overdraft"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    const card = parts.find((part) => part.type === "data-vendo-automation");
    expect(card).toBeDefined();
    const data = (card as { data: Record<string, unknown> }).data;
    expect(data.appId).toBe("app_auto_1");
    expect(data.name).toBe("Overdraft alert");
    expect(data.enabled).toBe(true);
    expect(data.trigger).toEqual(TRIGGER);
    expect(data.description).toBe("Emails you before an overdraft.");
    // The wire carries a COUNT of undecided standing grants, never the
    // approval objects themselves.
    expect(data.pendingGrants).toBe(2);
    expect(vendoAutomationPartSchema.safeParse({ type: "data-vendo-automation", ...data }).success).toBe(true);
  });

  it("an edit without an automation envelope emits no card", async () => {
    const guard = testGuard({});
    const registry = boundRegistry({
      vendo_apps_edit: {
        descriptor: editDescriptor,
        execute: () => ({ app: { id: "app_plain", name: "Plain edit" } }),
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn("vendo_apps_edit", { appId: "app_plain", instruction: "retitle it" }, "call_edit_2"),
      textTurn("Done.", "text_edit_2"),
    ]);
    const agent = createAgent({ model, tools: registry, guard });

    const response = await agent.stream({
      threadId: "thr_automation_none",
      message: userMessage("user_automation_none", "retitle my app"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.some((part) => part.type === "data-vendo-automation")).toBe(false);
  });

  it("a non-edit tool with an automation-shaped output emits no card (name-scoped, not duck-typed)", async () => {
    const guard = testGuard({});
    const registry = boundRegistry({
      echo: {
        descriptor: echoDescriptor,
        execute: () => AUTOMATED_EDIT_OUTPUT,
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn("echo", { value: "v" }, "call_echo_auto"),
      textTurn("Echoed.", "text_echo_auto"),
    ]);
    const agent = createAgent({ model, tools: registry, guard });

    const response = await agent.stream({
      threadId: "thr_automation_duck",
      message: userMessage("user_automation_duck", "echo something"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.some((part) => part.type === "data-vendo-automation")).toBe(false);
  });
});
