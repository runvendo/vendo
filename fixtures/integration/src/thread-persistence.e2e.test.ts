/** ENG-211 — default-thread persistence through the real composed HTTP wire.
 *
 * A client that starts without a thread id must learn the server-minted id from
 * turn 1, reuse it for turn 2, and keep approval auto-resume on that same row.
 * These journeys boot createVendo with a real PGlite store and cross the
 * loopback node:http bridge; no agent or repository methods are called directly.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  readSse,
  resetFixture,
  resumeApproval,
  textTurn,
  toolCallTurn,
  vendoApprovalId,
  type Stack,
} from "./harness.js";

const THREAD_ID_HEADER = "x-vendo-thread-id";

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

function userMessage(id: string, text: string) {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

describe("ENG-211: server-minted thread persistence", () => {
  it("returns the minted id and gives turn 2 the complete turn-1 context on the same stored thread", async () => {
    stack = await createStack({
      turns: [
        textTurn("Nice to meet you, Farouk.", "t1"),
        textTurn("Your name is Farouk.", "t2"),
      ],
    });

    const firstResponse = await stack.wireFetch("/threads", {
      method: "POST",
      body: JSON.stringify({ message: userMessage("u1", "My name is Farouk.") }),
    }, ADA);
    const threadId = firstResponse.headers.get(THREAD_ID_HEADER);
    expect(threadId).toMatch(/^thr_.+$/);
    await readSse(firstResponse);

    const secondResponse = await stack.wireFetch("/threads", {
      method: "POST",
      body: JSON.stringify({
        threadId,
        message: userMessage("u2", "What is my name?"),
      }),
    }, ADA);
    expect(secondResponse.headers.get(THREAD_ID_HEADER)).toBe(threadId);
    await readSse(secondResponse);

    expect(stack.model.prompts).toHaveLength(2);
    const secondPrompt = JSON.stringify(stack.model.prompts[1]);
    expect(secondPrompt).toContain("My name is Farouk.");
    expect(secondPrompt).toContain("Nice to meet you, Farouk.");
    expect(secondPrompt).toContain("What is my name?");

    const rows = await stack.sql<{ id: string }>(
      "SELECT id FROM vendo_threads WHERE subject = $1",
      [ADA.subject],
    );
    expect(rows).toEqual([{ id: threadId }]);
  });

  it("returns and reuses the same minted id when a parked approval resumes", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        toolCallTurn("host_invoices_delete", { id: "inv_0003" }, "call_resume"),
        textTurn("Approved deletion completed.", "t_resume"),
      ],
    });

    const pausedResponse = await stack.wireFetch("/threads", {
      method: "POST",
      body: JSON.stringify({ message: userMessage("u_resume", "Delete invoice inv_0003") }),
    }, ADA);
    const threadId = pausedResponse.headers.get(THREAD_ID_HEADER);
    expect(threadId).toMatch(/^thr_.+$/);
    const paused = await readSse(pausedResponse);

    const approvalId = vendoApprovalId(paused);
    const decision = await stack.wireFetch("/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ ids: [approvalId], decision: { approve: true } }),
    }, ADA);
    expect(decision.status).toBe(200);

    const resumedResponse = await resumeApproval(stack, threadId!, "call_resume", true, ADA);
    expect(resumedResponse.headers.get(THREAD_ID_HEADER)).toBe(threadId);
    await readSse(resumedResponse);

    const rows = await stack.sql<{ id: string }>(
      "SELECT id FROM vendo_threads WHERE subject = $1",
      [ADA.subject],
    );
    expect(rows).toEqual([{ id: threadId }]);
    expect(JSON.stringify(stack.model.prompts[1])).toContain("Delete invoice inv_0003");
  });
});
