import {
  DEFAULT_TRIGGER_ID,
  VENDO_MAKE_TOOL,
  VENDO_VIEW_STREAM,
  vendoAutomationPartSchema,
  type ToolDescriptor,
  type Trigger,
  type VendoAutomationPart,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
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

// stream-parts VendoAutomationPart — a request that rode the escalation ladder
// to an automation must land in the thread as a `data-vendo-automation` part
// (the AutomationCard), not just prose. The contract under test: the card is
// PUBLISHED by the apps runtime through the call's VENDO_VIEW_STREAM seam,
// because `vendo_make` answers with a receipt — four fields of words — and
// there is nothing left in its output to reconstruct a card from. The bridge
// hands that seam to `vendo_make` and to nothing else, which is the same 01 §16
// anti-smuggling rule the view part is gated by, now enforced at the source
// rather than by declining to duck-type an output.

const makeDescriptor: ToolDescriptor = {
  name: VENDO_MAKE_TOOL,
  description: "Make the user something to look at.",
  inputSchema: {
    type: "object",
    properties: { request: { type: "string" }, app: { type: "string" } },
    required: ["request"],
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

// A trigger is one entry of the app's LIST, so it carries the `id` that names it
// there — and the part's schema requires it. An id-less trigger is not a laxer
// card, it is no card at all: the seam below parses the whole part or drops it.
const TRIGGER = {
  id: DEFAULT_TRIGGER_ID,
  on: { kind: "schedule", every: "1d" },
  run: { kind: "agentic", prompt: "check the balance" },
} as const satisfies Trigger;

/** The exact part the apps runtime publishes when a ladder-authored automation
 *  is armed, on the stream id it names it with. */
const AUTOMATION_PART: VendoAutomationPart = {
  type: "data-vendo-automation",
  appId: "app_auto_1",
  name: "Overdraft alert",
  enabled: true,
  trigger: TRIGGER,
  description: "Emails you before an overdraft.",
  // The wire carries a COUNT of undecided standing grants, never the approval
  // objects themselves.
  pendingGrants: 2,
};

const AUTOMATION_STREAM_ID = "vendo-automation-app_auto_1";

/** What the tool ITSELF answers with: words, and never the card. */
const RECEIPT = {
  id: "app_auto_1",
  title: "Overdraft alert",
  status: "ready",
  say: "Overdraft alert is updated.",
};

describe("automation card part (data-vendo-automation)", () => {
  it("a make that armed an automation streams the card part through the view-stream seam", async () => {
    const guard = testGuard({});
    const registry = boundRegistry({
      [VENDO_MAKE_TOOL]: {
        descriptor: makeDescriptor,
        execute: (_args, _runCtx, call) => {
          const stream = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
          if (stream === undefined) throw new Error("make stream hook missing");
          stream({ id: AUTOMATION_STREAM_ID, part: AUTOMATION_PART });
          return RECEIPT;
        },
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn(VENDO_MAKE_TOOL, { app: "app_auto_1", request: "alert me before I overdraft" }, "call_make_1"),
      textTurn("Armed the overdraft alert.", "text_make_1"),
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
    // The producer's stream id survives the bridge: that id is what reconciles
    // a later update of the same card on the client.
    expect(card?.id).toBe(AUTOMATION_STREAM_ID);
    const data = (card as { data: Record<string, unknown> }).data;
    expect(data.appId).toBe("app_auto_1");
    expect(data.name).toBe("Overdraft alert");
    expect(data.enabled).toBe(true);
    expect(data.trigger).toEqual(TRIGGER);
    expect(data.description).toBe("Emails you before an overdraft.");
    expect(data.pendingGrants).toBe(2);
    expect(vendoAutomationPartSchema.safeParse({ type: "data-vendo-automation", ...data }).success).toBe(true);

    // And the MODEL got the receipt, which carries none of the card.
    const output = parts.find((part) => part.type === "tool-output-available");
    expect(output).toMatchObject({ toolCallId: "call_make_1", output: { status: "ok", output: RECEIPT } });
  });

  it("a make that armed nothing emits no card", async () => {
    const guard = testGuard({});
    const registry = boundRegistry({
      [VENDO_MAKE_TOOL]: {
        descriptor: makeDescriptor,
        // A plain change: the runtime publishes nothing, so nothing is on the
        // wire. The receipt alone can never raise a card.
        execute: () => ({ id: "app_plain", title: "Plain edit", status: "ready", say: "Plain edit is updated." }),
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn(VENDO_MAKE_TOOL, { app: "app_plain", request: "retitle it" }, "call_make_2"),
      textTurn("Done.", "text_make_2"),
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

  it("a non-make tool is handed no seam at all, so it cannot put a card on the wire", async () => {
    const guard = testGuard({});
    let seamOffered: boolean | undefined;
    const registry = boundRegistry({
      echo: {
        descriptor: echoDescriptor,
        execute: (_args, _runCtx, call) => {
          const stream = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
          seamOffered = stream !== undefined;
          // Try it anyway, and return an automation-shaped output besides: both
          // routes onto the card channel have to be shut for an arbitrary tool.
          stream?.({ id: AUTOMATION_STREAM_ID, part: AUTOMATION_PART });
          return {
            app: { id: "app_auto_1", name: "Overdraft alert" },
            automation: {
              enabled: true,
              trigger: { on: { kind: "schedule", every: "1d" }, run: { kind: "agentic", prompt: "check the balance" } },
            },
          };
        },
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

    expect(seamOffered).toBe(false);
    expect(parts.some((part) => part.type === "data-vendo-automation")).toBe(false);
  });
});
