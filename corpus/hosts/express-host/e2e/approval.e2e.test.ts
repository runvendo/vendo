import { describe, expect, it } from "vitest";
import { jsonPost, partsOfType, readSseMidStream, scriptedModel, startTestHost, textTurn, toolCallTurn, userMessage } from "./harness.js";

describe("Relay destructive approval round-trip", () => {
  it("asks, decides over the wire, resumes, and deletes exactly once", async () => {
    const threadId = "thr_relay_delete";
    const host = await startTestHost(scriptedModel([
      toolCallTurn("host_deleteTask", { id: "task-102" }, "call_delete"),
      textTurn("The task was deleted."),
    ]));
    try {
      // Build contract §1.4: the guarded call blocks INSIDE the tool call
      // awaiting the tap, holding this one request open — decide against the
      // still-open stream rather than a later, separately-posted resume (the
      // pre-flip `respondToApproval` two-turn dance this replaces).
      const paused = readSseMidStream(await fetch(`${host.baseUrl}/api/vendo/threads`, jsonPost({
        threadId,
        message: userMessage("msg_delete", "Delete the mobile empty states task"),
      })));
      // Build contract §1.5: tool calls are mirrored by the RUNTIME on its own
      // freshly-minted id — never the scripted model's own toolCallId
      // ("call_delete" never reaches this wire).
      const approvalCard = await paused.approval;
      expect(approvalCard).toMatchObject({ toolCallId: expect.any(String), risk: "destructive" });
      expect(host.tasks.deleteCalls).toBe(0);

      const approvalId = approvalCard.approvalId;
      expect(approvalId).toEqual(expect.stringMatching(/^apr_/));
      const decision = await fetch(`${host.baseUrl}/api/vendo/approvals/decide`, jsonPost({
        ids: [approvalId],
        decision: { approve: true },
      }));
      expect(decision.status).toBe(200);

      // The decision above unblocks the still-open call: the real DELETE runs
      // against the host, and the SAME stream carries the reply.
      const resumed = await paused.done;
      // Build contract §1.1: `output` is the tool's OWN return value
      // (`outcome.output`) — no second `status` wrapper.
      expect(partsOfType(resumed, "tool-output-available")[0]).toMatchObject({
        toolCallId: approvalCard.toolCallId,
        output: { deleted: true, id: "task-102" },
      });
      // Exactly once: the guarded call ran the real DELETE a single time —
      // never on the preview, never twice for one decision.
      expect(host.tasks.deleteCalls).toBe(1);
      const missing = await fetch(`${host.baseUrl}/api/tasks/task-102`);
      expect(missing.status).toBe(404);
    } finally {
      await host.close();
    }
  });
});
