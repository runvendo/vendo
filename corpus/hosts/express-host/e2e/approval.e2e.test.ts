import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { jsonPost, partsOfType, readSse, respondToApproval, scriptedModel, startTestHost, textTurn, toolCallTurn, userMessage } from "./harness.js";

describe("Relay destructive approval round-trip", () => {
  it("asks, decides over the wire, resumes, and deletes exactly once", async () => {
    const threadId = "thr_relay_delete";
    const host = await startTestHost(scriptedModel([
      toolCallTurn("host_deleteTask", { id: "task-102" }, "call_delete"),
      textTurn("The task was deleted."),
    ]));
    try {
      const paused = await readSse(await fetch(`${host.baseUrl}/api/vendo/threads`, jsonPost({
        threadId,
        message: userMessage("msg_delete", "Delete the mobile empty states task"),
      })));
      const approvalPart = partsOfType(paused, "data-vendo-approval")[0];
      expect(approvalPart).toMatchObject({ data: { toolCallId: "call_delete", risk: "destructive" } });
      expect(host.tasks.deleteCalls).toBe(0);

      const approvalId = (approvalPart?.data as { approvalId?: unknown }).approvalId;
      expect(approvalId).toEqual(expect.stringMatching(/^apr_/));
      const decision = await fetch(`${host.baseUrl}/api/vendo/approvals/decide`, jsonPost({
        ids: [approvalId],
        decision: { approve: true },
      }));
      expect(decision.status).toBe(200);

      const threadResponse = await fetch(`${host.baseUrl}/api/vendo/threads/${threadId}`);
      expect(threadResponse.status).toBe(200);
      const thread = await threadResponse.json() as { messages: UIMessage[] };
      const assistant = [...thread.messages].reverse().find((message) => message.role === "assistant");
      expect(assistant).toBeDefined();

      const resumed = await readSse(await fetch(`${host.baseUrl}/api/vendo/threads`, jsonPost({
        threadId,
        message: respondToApproval(assistant!, "call_delete", true),
      })));
      expect(partsOfType(resumed, "tool-output-available")[0]).toMatchObject({
        toolCallId: "call_delete",
        output: { status: "ok", output: { deleted: true, id: "task-102" } },
      });
      expect(host.tasks.deleteCalls).toBe(1);
      const missing = await fetch(`${host.baseUrl}/api/tasks/task-102`);
      expect(missing.status).toBe(404);
    } finally {
      await host.close();
    }
  });
});
