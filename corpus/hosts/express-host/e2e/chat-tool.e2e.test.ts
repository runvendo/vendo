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
      const output = partsOfType(stream, "tool-output-available")[0];
      expect(output).toMatchObject({
        toolCallId: "call_list",
        output: {
          status: "ok",
          output: expect.arrayContaining([
            expect.objectContaining({ id: "task-101", title: "Polish onboarding checklist", assignee: expect.objectContaining({ name: "Ada Chen" }) }),
          ]),
        },
      });
      expect(partsOfType(stream, "text-delta")).toContainEqual(expect.objectContaining({ delta: "Here are the current Relay tasks." }));
    } finally {
      await host.close();
    }
  });
});
