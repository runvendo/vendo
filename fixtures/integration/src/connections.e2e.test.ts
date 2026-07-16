/** J-connections — per-user connected accounts over the PUBLIC wire
 * (block-actions design §B, 04-actions §3).
 *
 * The stack composes the REAL composioConnector aimed at a stub Composio
 * backend (the same wire shapes the live service serves), so these journeys
 * exercise the umbrella's /connections routes, the typed connect-required
 * chat outcome, the audit identity enrichment, and — the point — per-principal
 * isolation: Ada's connected account is invisible and untouchable as Bob.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composioConnector } from "@vendoai/actions";
import {
  ADA,
  BOB,
  createStack,
  partsOfType,
  readSse,
  textTurn,
  toolCallTurn,
  type Stack,
} from "./harness.js";

interface StubAccount {
  id: string;
  toolkit: { slug: string };
  status: string;
  user_id: string;
  created_at: string;
}

interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: Record<string, unknown>;
}

/** A Composio backend stub: one gmail tool; Ada holds the only active account. */
function createComposioStub() {
  const requests: StubRequest[] = [];
  let accounts: StubAccount[] = [
    { id: "ca_ada", toolkit: { slug: "gmail" }, status: "ACTIVE", user_id: ADA.subject, created_at: "2026-07-01T00:00:00Z" },
  ];

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0
      ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
      : undefined;
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      ...(body === undefined ? {} : { body }),
    });
    res.setHeader("content-type", "application/json");

    if (req.method === "GET" && url.pathname === "/api/v3/tools") {
      res.end(JSON.stringify({
        items: [{
          slug: "GMAIL_SEND_EMAIL",
          toolkit_slug: "gmail",
          description: "Send an email",
          input_parameters: { type: "object", properties: { to: { type: "string" } } },
        }],
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v3/auth_configs") {
      res.end(JSON.stringify({
        items: url.searchParams.get("toolkit_slug") === "gmail"
          ? [{ id: "ac_gmail", status: "ENABLED" }]
          : [],
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v3/connected_accounts/link") {
      const subject = (body as { user_id?: string }).user_id ?? "unknown";
      const id = `ca_new_${subject}`;
      if (!accounts.some((account) => account.id === id)) {
        accounts.push({
          id,
          toolkit: { slug: "gmail" },
          status: "ACTIVE",
          user_id: subject,
          created_at: new Date().toISOString(),
        });
      }
      res.end(JSON.stringify({ redirect_url: `https://connect.composio.test/oauth/${id}`, connected_account_id: id }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v3/connected_accounts") {
      const users = url.searchParams.getAll("user_ids");
      const ids = url.searchParams.getAll("connected_account_ids");
      res.end(JSON.stringify({
        items: accounts.filter((account) =>
          (users.length === 0 || users.includes(account.user_id))
          && (ids.length === 0 || ids.includes(account.id))),
      }));
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v3/connected_accounts/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      accounts = accounts.filter((account) => account.id !== id);
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/v3/tools/execute/")) {
      const subject = (body as { user_id?: string }).user_id ?? "unknown";
      const active = accounts.some((account) => account.user_id === subject && account.status === "ACTIVE");
      if (active) {
        res.end(JSON.stringify({ successful: true, data: { messageId: `msg_${subject}` } }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: {
            message: `No connected account found for user ID ${subject} for toolkit gmail`,
            code: 1810,
            slug: "ActionExecute_ConnectedAccountNotFound",
            status: 400,
          },
        }));
      }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `no stub for ${req.method} ${url.pathname}` } }));
  };

  return { handler, requests };
}

describe("connected accounts over the wire", () => {
  let stub: ReturnType<typeof createComposioStub>;
  let stubServer: ReturnType<typeof createServer>;
  let stubUrl: string;
  let stack: Stack;

  beforeAll(async () => {
    stub = createComposioStub();
    stubServer = createServer((req, res) => void stub.handler(req, res));
    await new Promise<void>((resolve, reject) => {
      stubServer.once("error", reject);
      stubServer.listen(0, "127.0.0.1", () => {
        stubServer.off("error", reject);
        resolve();
      });
    });
    stubUrl = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;

    stack = await createStack({
      connectors: [composioConnector({ apiKey: "stub-key", apps: ["gmail"], baseUrl: stubUrl })],
      turns: [
        // Bob's turn: the model calls the gmail tool; Bob has no connection.
        toolCallTurn("gmail_GMAIL_SEND_EMAIL", { to: "ada@example.test" }, "call_bob_send"),
        textTurn("You need to connect gmail first.", "text_bob"),
        // Ada's turn: the same call executes through her active account.
        toolCallTurn("gmail_GMAIL_SEND_EMAIL", { to: "bob@example.test" }, "call_ada_send"),
        textTurn("Sent.", "text_ada"),
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await stack?.close();
    stubServer?.close();
    stubServer?.closeAllConnections();
  });

  it("reports the byo connections posture on /status", async () => {
    const status = await (await stack.wireFetch("/status", {}, ADA)).json() as { blocks: { connections: unknown } };
    expect(status.blocks.connections).toBe("byo");
  });

  it("lists, initiates, polls, and disconnects per-principal over the wire", async () => {
    const listed = await (await stack.wireFetch("/connections", {}, ADA)).json() as { connections: Array<{ id: string }> };
    expect(listed.connections).toEqual([
      expect.objectContaining({ id: "ca_ada", connector: "composio", toolkit: "gmail", status: "active" }),
    ]);

    const initiateResponse = await stack.wireFetch("/connections/initiate", {
      method: "POST",
      body: JSON.stringify({ toolkit: "gmail", callbackUrl: "https://host.test/vendo" }),
    }, ADA);
    expect(initiateResponse.status).toBe(200);
    const initiated = await initiateResponse.json() as { id: string; connector: string; redirectUrl: string };
    expect(initiated.connector).toBe("composio");
    expect(initiated.redirectUrl).toContain("https://connect.composio.test/oauth/");

    // The initiate rode Composio's link API with entityId = Ada's subject.
    const link = stub.requests.find((request) => request.path === "/api/v3/connected_accounts/link");
    expect(link?.body).toMatchObject({ auth_config_id: "ac_gmail", user_id: ADA.subject });

    const polled = await (await stack.wireFetch(`/connections/${initiated.id}?connector=composio`, {}, ADA)).json() as { status: string };
    expect(polled.status).toBe("active");

    const disconnect = await stack.wireFetch(`/connections/${initiated.id}?connector=composio`, { method: "DELETE" }, ADA);
    expect(disconnect.status).toBe(200);
    const after = await (await stack.wireFetch("/connections", {}, ADA)).json() as { connections: Array<{ id: string }> };
    expect(after.connections.map((connection) => connection.id)).toEqual(["ca_ada"]);
  });

  it("ADVERSARIAL: one principal can never see or sever another's connection", async () => {
    // Bob's list never contains Ada's account.
    const bobList = await (await stack.wireFetch("/connections", {}, BOB)).json() as { connections: unknown[] };
    expect(bobList.connections).toEqual([]);

    // Bob probing Ada's connection id reads as absent, not forbidden — no oracle.
    const probe = await stack.wireFetch("/connections/ca_ada?connector=composio", {}, BOB);
    expect(probe.status).toBe(404);

    // Bob cannot disconnect Ada's account, and no delete reaches the broker.
    const deletesBefore = stub.requests.filter((request) => request.method === "DELETE").length;
    const sever = await stack.wireFetch("/connections/ca_ada?connector=composio", { method: "DELETE" }, BOB);
    expect(sever.status).toBe(404);
    expect(stub.requests.filter((request) => request.method === "DELETE")).toHaveLength(deletesBefore);

    // Ada still holds her account.
    const adaList = await (await stack.wireFetch("/connections", {}, ADA)).json() as { connections: Array<{ id: string }> };
    expect(adaList.connections).toEqual([expect.objectContaining({ id: "ca_ada" })]);
  });

  it("refuses to initiate for an anonymous (ephemeral) visitor", async () => {
    const response = await stack.wireFetch("/connections/initiate", {
      method: "POST",
      body: JSON.stringify({ toolkit: "gmail" }),
    });
    expect(response.status).toBe(403);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain("signed-in");
  });

  it("refuses to initiate for a synthetic webhook subject", async () => {
    const response = await fetch(`${stack.baseUrl}/api/vendo/connections/initiate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vendo-test-user": "webhook:stripe" },
      body: JSON.stringify({ toolkit: "gmail" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain("reserved");
  });

  it("surfaces a missing connection as a typed connect-required outcome in chat, then executes after connecting", async () => {
    // Bob: no connection → connect-required + the data-vendo-connect part.
    const bobTurn = await stack.wireFetch("/threads", {
      method: "POST",
      body: JSON.stringify({ message: { id: "user_bob_1", role: "user", parts: [{ type: "text", text: "Email Ada" }] } }),
    }, BOB);
    const bobRead = await readSse(bobTurn);
    const connectParts = partsOfType(bobRead, "data-vendo-connect");
    expect(connectParts).toHaveLength(1);
    expect(connectParts[0]?.data).toMatchObject({
      toolCallId: "call_bob_send",
      connector: "composio",
      toolkit: "gmail",
    });
    const bobOutcome = bobRead.parts.find((part) => part.type === "tool-output-available") as
      | { output?: { status?: string; connect?: { toolkit?: string } } }
      | undefined;
    expect(bobOutcome?.output?.status).toBe("connect-required");
    expect(bobOutcome?.output?.connect?.toolkit).toBe("gmail");

    // Ada: active connection → the same tool executes.
    const adaTurn = await stack.wireFetch("/threads", {
      method: "POST",
      body: JSON.stringify({ message: { id: "user_ada_1", role: "user", parts: [{ type: "text", text: "Email Bob" }] } }),
    }, ADA);
    const adaRead = await readSse(adaTurn);
    expect(partsOfType(adaRead, "data-vendo-connect")).toHaveLength(0);
    const adaOutcome = adaRead.parts.find((part) => part.type === "tool-output-available") as
      | { output?: { status?: string; output?: { messageId?: string } } }
      | undefined;
    expect(adaOutcome?.output?.status).toBe("ok");
    expect(adaOutcome?.output?.output?.messageId).toBe(`msg_${ADA.subject}`);
  });

  it("audits connector executions with the connector account identity (cross-cutting enrichment)", async () => {
    const events = await (await stack.wireFetch("/activity", {}, BOB)).json() as Array<{
      kind: string;
      tool?: string;
      outcome?: string;
      detail?: { connectorAccount?: { connector?: string; toolkit?: string; entityId?: string } };
    }>;
    const connectorCall = events.find((event) => event.kind === "tool-call" && event.tool === "gmail_GMAIL_SEND_EMAIL");
    expect(connectorCall).toBeDefined();
    expect(connectorCall?.outcome).toBe("connect-required");
    expect(connectorCall?.detail?.connectorAccount).toEqual({
      connector: "composio",
      toolkit: "gmail",
      entityId: BOB.subject,
    });

    const adaEvents = await (await stack.wireFetch("/activity", {}, ADA)).json() as typeof events;
    const adaCall = adaEvents.find((event) => event.kind === "tool-call" && event.tool === "gmail_GMAIL_SEND_EMAIL");
    expect(adaCall?.outcome).toBe("ok");
    expect(adaCall?.detail?.connectorAccount).toEqual({
      connector: "composio",
      toolkit: "gmail",
      entityId: ADA.subject,
    });
  });
});
