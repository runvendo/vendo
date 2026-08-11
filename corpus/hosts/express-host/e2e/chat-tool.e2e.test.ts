import { describe, expect, it } from "vitest";
import { jsonPost, partsOfType, readSse, scriptedModel, startTestHost, textTurn, toolCallTurn, userMessage } from "./harness.js";

describe("Relay chat to host tool", () => {
  it("calls the Express task API through the learned loopback origin", async () => {
    const host = await startTestHost(scriptedModel([
      toolCallTurn("host_listTasks", {}, "call_list"),
      textTurn("Here are the current Relay tasks."),
    ]));
    try {
      const stream = await readSse(await fetch(`${host.baseUrl}/api/vendo/threads`, jsonPost({
        threadId: "thr_relay_list",
        message: userMessage("msg_list", "Show me our tasks"),
      })));
      // Build contract §1.5: tool calls are mirrored by the RUNTIME on its own
      // freshly-minted id — never the scripted model's own toolCallId
      // ("call_list" never reaches this wire).
      const output = partsOfType(stream, "tool-output-available")[0];
      expect(output).toMatchObject({
        toolCallId: expect.any(String),
        // Build contract §1.1: `output` is the tool's OWN return value
        // (`outcome.output`) — no second `status` wrapper.
        output: expect.arrayContaining([
          expect.objectContaining({ id: "task-101", title: "Polish onboarding checklist", assignee: expect.objectContaining({ name: "Ada Chen" }) }),
        ]),
      });
      expect(partsOfType(stream, "text-delta")).toContainEqual(expect.objectContaining({ delta: "Here are the current Relay tasks." }));
    } finally {
      await host.close();
    }
  });
});
