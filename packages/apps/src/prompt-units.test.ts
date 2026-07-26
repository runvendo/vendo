import type { RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
  type ScriptedModelCall,
} from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_units_prompt" },
  venue: "chat",
  presence: "present",
  sessionId: "session_units_prompt",
};

const tools: ToolRegistry = {
  async descriptors() {
    return [{
      name: "host_transferMoney",
      description: "Send money from checking. IRREVERSIBLY MOVES MONEY.",
      risk: "destructive" as const,
      inputSchema: {
        type: "object",
        required: ["amount", "recipient_name"],
        properties: {
          amount: { type: "integer", description: "Amount to send in cents (positive whole number), e.g. 50000 = $500.00" },
          recipient_name: { type: "string" },
        },
      },
    }, {
      name: "host_payBill",
      description: "Pay a bill.",
      risk: "write" as const,
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number", description: "Amount in dollars, e.g. 25.50" } },
      },
    }];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "missing" } };
  },
};

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

/**
 * Re-gate 2026-07-26 I5-C: the island fired 25 (=$0.25) for a typed $25. The
 * old tool sketch showed only FIELD NAMES — `(input: {amount,
 * recipient_name})` — so the model never saw that `amount` is cents (that
 * unit lives in the property description, which the prompt dropped). The
 * sketch now carries the unit, and the contract teaches the conversion.
 */
describe("amount units in the generation prompt", () => {
  it("annotates cents and dollars fields in the tool input sketch and teaches the conversion", async () => {
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return '<App name="Send money"><Text text="Send money"/><Disclaimer reason="fixture"/></App>';
    });
    const runtime = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog: [], model });

    await runtime.create({ prompt: "send $25 to mom" }, ctx);

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("amount (integer cents)");
    expect(prompt).toContain("amount (dollars)");
    // The conversion rule rides the same prompt (host-tools section).
    expect(prompt).toMatch(/multiply.*by 100|×\s*100|x100/i);
  });
});

describe("contradictory unit metadata teaches nothing", () => {
  it("a *cents field DESCRIBED as dollars gets no sketch annotation (matches the runtime guard's skip)", async () => {
    const contradictoryTools: ToolRegistry = {
      async descriptors() {
        return [{
          name: "host_oddSetter",
          description: "Sets an oddly-documented value.",
          risk: "write" as const,
          inputSchema: {
            type: "object",
            properties: { amountCents: { type: "number", description: "Amount in dollars (legacy field name)" } },
          },
        }];
      },
      async execute() {
        return { status: "error", error: { code: "not-found", message: "missing" } };
      },
    };
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return '<App name="Odd"><Text text="Odd"/><Disclaimer reason="fixture"/></App>';
    });
    const runtime = createApps({ store: memoryStore(), guard: guardFixture(), tools: contradictoryTools, catalog: [], model });

    await runtime.create({ prompt: "set the value" }, ctx);

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("host_oddSetter");
    expect(prompt).not.toContain("amountCents (integer cents)");
    expect(prompt).not.toContain("amountCents (dollars)");
  });
});
