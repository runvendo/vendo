import { VENDO_APPS_CREATE_TOOL, vendoBuildFailedPartSchema, type ToolDescriptor } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  partOfType,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
} from "./test-helpers.js";

// 0.4.4 cert defect B — the full failing-turn lifecycle. A chat-turn app build
// that terminally fails used to come back as a plain error OUTCOME the model
// alone could see: the tray rendered nothing, and the model re-ran the
// minutes-long doomed build until the step cap — a thread stuck "streaming"
// for 10+ minutes with no banner and no reason. The contract under test:
// the turn ENDS on the first failed build, and the classified reason reaches
// the surface as a renderable `data-vendo-build-failed` part.

const createDescriptor: ToolDescriptor = {
  name: VENDO_APPS_CREATE_TOOL,
  description: "Create a Vendo app from a natural-language prompt.",
  inputSchema: {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
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

const BUILD_FAILED_MESSAGE = "app build failed: generation failed";

describe("failed app build in a chat turn (0.4.4 cert defect B)", () => {
  it("ends the turn after the first failed build and streams the reason", async () => {
    const guard = testGuard({});
    // The apps registry maps the create-throw to an error outcome whose
    // message carries the classified reason (runtime.create's re-throw);
    // boundRegistry's catch arm reproduces that exact shape.
    const registry = boundRegistry({
      [VENDO_APPS_CREATE_TOOL]: {
        descriptor: createDescriptor,
        execute: () => {
          throw new Error(BUILD_FAILED_MESSAGE);
        },
      },
    }, guard);
    // ONE scripted turn: if the loop asked the model for another step after
    // the failed build, the scripted model would throw ("scripted model
    // exhausted") and the stream would carry an error part.
    const model = scriptedModel([
      toolCallTurn(VENDO_APPS_CREATE_TOOL, { prompt: "track invoice statuses" }, "call_build_1"),
    ]);
    const agent = createAgent({ model, tools: registry, guard });

    const response = await agent.stream({
      threadId: "thr_build_failed",
      message: userMessage("user_build_failed", "build me a small app that tracks invoice statuses"),
      ctx: ctx(),
    });
    // readSse asserts the terminal [DONE] frame — the turn TERMINATED.
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    // The reason reached the surface as a renderable part.
    const banner = parts.find((part) => part.type === "data-vendo-build-failed");
    expect(banner).toBeDefined();
    const data = (banner as { data: Record<string, unknown> }).data;
    expect(data.toolCallId).toBe("call_build_1");
    expect(data.reason).toBe(BUILD_FAILED_MESSAGE);
    expect(vendoBuildFailedPartSchema.safeParse({ type: "data-vendo-build-failed", ...data }).success).toBe(true);
    // The turn ended because the build failed, not because a cap ran out.
    expect(parts.some((part) => part.type === "data-vendo-step-limit")).toBe(false);
    // Exactly one model step: no in-turn retry of the doomed build.
    expect(model.prompts).toHaveLength(1);

    // The banner survives persistence: a restored thread still shows why.
    const thread = await agent.threads.get("thr_build_failed", ctx());
    const persisted = thread?.messages.find((message) => message.role === "assistant");
    expect(persisted).toBeDefined();
    const persistedBanner = partOfType(persisted!, "data-vendo-build-failed");
    expect((persistedBanner as { data?: { reason?: string } } | undefined)?.data?.reason)
      .toBe(BUILD_FAILED_MESSAGE);
  });

  it("a successful build does not end the turn", async () => {
    const guard = testGuard({});
    const registry = boundRegistry({
      [VENDO_APPS_CREATE_TOOL]: {
        descriptor: createDescriptor,
        execute: () => ({ id: "app_1", name: "Invoice tracker" }),
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn(VENDO_APPS_CREATE_TOOL, { prompt: "track invoice statuses" }, "call_build_ok"),
      textTurn("Built it.", "text_build_ok"),
    ]);
    const agent = createAgent({ model, tools: registry, guard });

    const response = await agent.stream({
      threadId: "thr_build_ok",
      message: userMessage("user_build_ok", "build me an invoice tracker"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    expect(parts.some((part) => part.type === "data-vendo-build-failed")).toBe(false);
    // The model got its follow-up step after the successful build.
    expect(model.prompts).toHaveLength(2);
  });

  it("a cheap create error (no build-failed prefix) neither ends the turn nor raises the banner", async () => {
    const guard = testGuard({});
    // e.g. the runtime's input validation — an instant error the model can
    // correct by re-calling with fixed args; nothing minutes-long ran.
    const registry = boundRegistry({
      [VENDO_APPS_CREATE_TOOL]: {
        descriptor: createDescriptor,
        execute: () => {
          throw new Error("prompt must be a non-empty string");
        },
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn(VENDO_APPS_CREATE_TOOL, { prompt: "x" }, "call_build_cheap"),
      textTurn("Let me fix the arguments.", "text_build_cheap"),
    ]);
    const agent = createAgent({ model, tools: registry, guard });

    const response = await agent.stream({
      threadId: "thr_build_cheap",
      message: userMessage("user_build_cheap", "build me an app"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    expect(parts.some((part) => part.type === "data-vendo-build-failed")).toBe(false);
    expect(model.prompts).toHaveLength(2);
  });

  it("a failed non-build tool neither ends the turn nor raises the banner", async () => {
    const guard = testGuard({});
    const registry = boundRegistry({
      echo: {
        descriptor: echoDescriptor,
        execute: () => {
          throw new Error("echo broke");
        },
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn("echo", { value: "v" }, "call_echo_fail"),
      textTurn("That tool failed; moving on.", "text_echo_fail"),
    ]);
    const agent = createAgent({ model, tools: registry, guard });

    const response = await agent.stream({
      threadId: "thr_echo_fail",
      message: userMessage("user_echo_fail", "echo something"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    expect(parts.some((part) => part.type === "data-vendo-build-failed")).toBe(false);
    // The loop continued: ordinary tool errors stay the model's to handle.
    expect(model.prompts).toHaveLength(2);
  });
});
