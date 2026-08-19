// @vitest-environment jsdom
/**
 * The standalone chat hook against a REAL HTTP listener speaking the mount's
 * own shapes — the fetch, the round trip, the stream and the thread-id header
 * are all real; only the agent behind them is scripted.
 *
 * The two properties worth pinning are the ones a host cannot see until it is
 * too late: the conversation's id is handed OUT rather than kept, and a pending
 * approval comes back from the server on reload rather than from anything this
 * hook stored.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useVendoChat } from "../src/use-vendo-chat.js";

const THREAD_ID = "thr_seeded";

/** One parked approval, exactly as a reloaded transcript carries it. */
const parked: UIMessage[] = [
  { id: "m_1", role: "user", parts: [{ type: "text", text: "refund invoice #7" }] },
  {
    id: "m_2",
    role: "assistant",
    parts: [
      {
        type: "tool-host_refund",
        toolCallId: "call_1",
        state: "approval-requested",
        input: { invoiceId: "7" },
        approval: { id: "apr_1" },
      } as UIMessage["parts"][number],
    ],
  },
];

interface Mount {
  url: string;
  /** Every POST body the browser sent, in order. */
  sent: Array<Record<string, unknown>>;
  thread: UIMessage[];
  close(): Promise<void>;
}

/** The mount's two routes, and nothing else: a turn that answers, and the
 *  transcript read-back a reload does. */
async function serveMount(): Promise<Mount> {
  const sent: Array<Record<string, unknown>> = [];
  const thread: UIMessage[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      if (incoming.method === "GET" && url.pathname === `/threads/${THREAD_ID}`) {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ id: THREAD_ID, messages: thread }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      sent.push(body);
      // A real mount answers a decided approval by RUNNING the call it parked,
      // so the turn's reply carries that call's output. Without it the approval
      // stays pending forever and the SDK, correctly, keeps re-sending.
      const decided = (body["message"] as UIMessage | undefined)?.parts.find(
        (part) => "state" in part && part.state === "approval-responded",
      ) as { toolCallId?: string } | undefined;
      const response = createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            if (decided?.toolCallId !== undefined) {
              writer.write({ type: "tool-output-available", toolCallId: decided.toolCallId, output: { ok: true } });
            }
            writer.write({ type: "text-start", id: "t1" });
            writer.write({ type: "text-delta", id: "t1", delta: "done" });
            writer.write({ type: "text-end", id: "t1" });
          },
        }),
      });
      outgoing.writeHead(200, {
        ...Object.fromEntries(response.headers),
        "x-vendo-thread-id": THREAD_ID,
      });
      outgoing.end(await response.text());
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    thread,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let mount: Mount;

beforeEach(async () => {
  mount = await serveMount();
});

afterEach(async () => {
  await mount.close();
});

describe("useVendoChat", () => {
  it("hands the server's thread id out instead of keeping one", async () => {
    const announced: string[] = [];
    const { result } = renderHook(() =>
      useVendoChat({ api: mount.url, onThreadId: (id) => announced.push(id) }));

    result.current.sendMessage({ text: "hello" });

    await waitFor(() => expect(result.current.threadId).toBe(THREAD_ID));
    expect(announced).toEqual([THREAD_ID]);
    // The whole no-hidden-storage claim, checked rather than asserted in prose.
    expect(globalThis.localStorage.length).toBe(0);
    expect(globalThis.sessionStorage.length).toBe(0);
  });

  it("sends the live thread id back on the next turn", async () => {
    const { result } = renderHook(() => useVendoChat({ api: mount.url }));

    result.current.sendMessage({ text: "hello" });
    await waitFor(() => expect(result.current.threadId).toBe(THREAD_ID));
    result.current.sendMessage({ text: "again" });

    await waitFor(() => expect(mount.sent).toHaveLength(2));
    expect(mount.sent[0]?.["threadId"]).toBeUndefined();
    expect(mount.sent[1]?.["threadId"]).toBe(THREAD_ID);
  });

  it("reads a parked approval back from the server on reload", async () => {
    mount.thread.push(...parked);

    const { result } = renderHook(() => useVendoChat({ api: mount.url, threadId: THREAD_ID }));

    await waitFor(() => expect(result.current.interruptions).toHaveLength(1));
    expect(result.current.interruptions[0]).toEqual({
      id: "apr_1",
      type: "approval",
      toolCall: { id: "call_1", tool: "host_refund", args: { invoiceId: "7" } },
    });
  });

  it("resume answers the approval and the decided turn goes back to the server", async () => {
    mount.thread.push(...parked);
    const { result } = renderHook(() => useVendoChat({ api: mount.url, threadId: THREAD_ID }));
    await waitFor(() => expect(result.current.interruptions).toHaveLength(1));

    await result.current.resume({ apr_1: "approve" });

    // The SDK sends the decided messages back on its own once every requested
    // approval has an answer — that send IS the resume.
    await waitFor(() => expect(mount.sent).toHaveLength(1));
    await waitFor(() => expect(result.current.interruptions).toHaveLength(0));
  });
});
