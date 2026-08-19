/**
 * The STANDALONE agent leg: a real `agent()` behind a real `agentHandler()`, on
 * its own loopback listener, with nothing stubbed between it and the page.
 *
 * The browser half is `useVendoChat` (@vendoai/ui); this is the half it talks
 * to. Both are real, which is the whole point — this repo has shipped a dead
 * feature more than once because the producer and the consumer each mocked the
 * other and could therefore never disagree (CLAUDE.md).
 *
 * Only the THINKER is scripted, exactly as the node suites script it: a harness
 * is `{ name, run }` and nothing more, so a fixture brain needs no model, no
 * provider key and no network. It calls one write-risk tool, which the policy
 * says to ASK about — so the turn parks on a real guard approval, the runtime
 * streams a real `approval-requested` part, and the only thing that can move it
 * forward is the browser answering.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { agent, agentHandler, tool } from "@vendoai/agents";
import type { Harness } from "@vendoai/core";
import { createStore } from "@vendoai/store";

const BASE_PATH = "/api/agent";
const CONTROL = "/__agent";

export interface AgentBackend {
  /** The origin the Vite proxy targets for `/api/agent` and `/__agent`. */
  url: string;
  close(): Promise<void>;
}

export async function startAgentBackend(): Promise<AgentBackend> {
  /** SERVER-SIDE evidence that the approved call really ran. A spec that only
   *  reads the page cannot tell an executed refund from a rendered sentence. */
  const refunded: string[] = [];

  const refund = tool({
    name: "host_refund",
    description: "Refund an invoice",
    inputSchema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
    risk: "write",
    execute(input) {
      refunded.push(String((input as { invoiceId?: unknown }).invoiceId));
      return { refunded: true };
    },
  });

  /** One write, then a word about it. The call BLOCKS until a person answers,
   *  which is what makes the page's approval the thing that unblocks the turn. */
  const scripted: Harness<unknown> = {
    name: "refunder",
    async *run(turn) {
      const outcome = await turn.tools.call("host_refund", { invoiceId: "inv_7" });
      yield { type: "text", delta: outcome.status === "ok" ? "Refund sent." : "Refund not sent." };
    },
  };

  const support = agent({
    name: "support",
    harness: scripted,
    store: createStore({ dataDir: "memory://integration-browser-agent" }),
    tools: [refund],
    guard: { policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } },
  });

  const handle = support.handler({
    basePath: BASE_PATH,
    // The fixture's whole host session: identity resolution has its own unit
    // tests, and a fixed subject keeps this spec about the seam.
    resolveUser: async () => ({ subject: "user_ada" }),
  });

  const server = createServer((incoming, outgoing) => {
    void serve(incoming, outgoing).catch((error: unknown) => {
      outgoing.statusCode = 500;
      outgoing.end(error instanceof Error ? error.message : "agent bridge failed");
    });
  });

  async function serve(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (url.pathname === `${CONTROL}/refunds`) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ refunded }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const response = await handle(new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
      method: incoming.method,
      headers,
      ...(chunks.length === 0 ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }),
    }));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    if (response.body === null) {
      outgoing.end();
      return;
    }
    // STREAMED, never buffered — for the reason the umbrella's bridge states:
    // `arrayBuffer()` waits for the turn to END, and a parked turn never does.
    // The approval card would never reach the browser, so the tap that resumes
    // the turn could never happen and the turn could only time out.
    outgoing.flushHeaders();
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      outgoing.write(Buffer.from(value));
    }
    outgoing.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
