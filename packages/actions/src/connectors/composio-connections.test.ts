import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toolOutcomeSchema, type RunContext } from "@vendoai/core";
import { composioConnector } from "./composio.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** The Composio stub: one gmail tool + a connected-accounts surface for two
 * subjects, recording every request for isolation asserts. */
function composioStub() {
  const requests: Array<{ method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];
  const accounts = [
    { id: "ca_ada", toolkit: { slug: "gmail" }, status: "ACTIVE", user_id: "user_ada", created_at: "2026-07-01T00:00:00Z" },
    { id: "ca_bob", toolkit: { slug: "gmail" }, status: "ACTIVE", user_id: "user_bob", created_at: "2026-07-01T00:00:00Z" },
  ];
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://stub");
    const entry: (typeof requests)[number] = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams };
    res.setHeader("content-type", "application/json");

    if (req.method === "GET" && url.pathname === "/api/v3/tools") {
      requests.push(entry);
      res.end(JSON.stringify({
        items: [{
          slug: "GMAIL_SEND_EMAIL",
          toolkit_slug: "gmail",
          description: "Send email",
          input_parameters: { type: "object" },
        }],
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v3/auth_configs") {
      requests.push(entry);
      if (url.searchParams.get("toolkit_slug") === "gmail") {
        res.end(JSON.stringify({ items: [{ id: "ac_gmail", toolkit: { slug: "gmail" }, status: "ENABLED" }] }));
      } else {
        res.end(JSON.stringify({ items: [] }));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v3/connected_accounts/link") {
      entry.body = await jsonBody(req);
      requests.push(entry);
      res.end(JSON.stringify({ redirect_url: "https://connect.composio.test/oauth/abc", connected_account_id: "ca_new" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v3/connected_accounts") {
      requests.push(entry);
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
      requests.push(entry);
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/v3/tools/execute/")) {
      entry.body = await jsonBody(req);
      requests.push(entry);
      if ((entry.body as { user_id?: unknown }).user_id === "user_ada") {
        res.end(JSON.stringify({ successful: true, data: { messageId: "msg_1" } }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: {
            message: "No connected account found for user ID user_bob for toolkit gmail",
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

describe("composioConnector connect-required + identity", () => {
  it("maps a missing-connection execution to a typed connect-required outcome", async () => {
    const stub = composioStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = composioConnector({ apiKey: "secret", apps: ["gmail"], baseUrl: server.url });
    await connector.descriptors();
    const outcome = await connector.execute(
      { id: "call_1", tool: "gmail_GMAIL_SEND_EMAIL", args: { to: "x@example.test" } },
      { ...ctx, principal: { kind: "user", subject: "user_bob" } },
    );
    expect(toolOutcomeSchema.parse(outcome)).toMatchObject({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail" },
    });
    expect((outcome as { connect?: { message?: string } }).connect?.message).toContain("gmail");
  });

  it("attaches the connector account identity to every execution outcome", async () => {
    const stub = composioStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = composioConnector({ apiKey: "secret", apps: ["gmail"], baseUrl: server.url });
    await connector.descriptors();
    const ok = await connector.execute({ id: "call_1", tool: "gmail_GMAIL_SEND_EMAIL", args: {} }, ctx);
    expect(ok).toMatchObject({
      status: "ok",
      connectorAccount: { connector: "composio", toolkit: "gmail", entityId: "user_ada" },
    });
    const needsConnect = await connector.execute(
      { id: "call_2", tool: "gmail_GMAIL_SEND_EMAIL", args: {} },
      { ...ctx, principal: { kind: "user", subject: "user_bob" } },
    );
    expect(needsConnect).toMatchObject({
      status: "connect-required",
      connectorAccount: { connector: "composio", toolkit: "gmail", entityId: "user_bob" },
    });
  });
});

describe("composioConnector connections", () => {
  it("initiates a connection through auth-config lookup and the link endpoint", async () => {
    const stub = composioStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = composioConnector({ apiKey: "secret", baseUrl: server.url });
    const initiated = await connector.connections!.initiate("user_ada", "gmail", {
      callbackUrl: "https://host.test/settings",
    });
    expect(initiated).toEqual({ id: "ca_new", redirectUrl: "https://connect.composio.test/oauth/abc" });
    const link = stub.requests.find((request) => request.path === "/api/v3/connected_accounts/link");
    expect(link?.body).toEqual({
      auth_config_id: "ac_gmail",
      user_id: "user_ada",
      callback_url: "https://host.test/settings",
    });
  });

  it("refuses to initiate for a toolkit with no auth config", async () => {
    const stub = composioStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = composioConnector({ apiKey: "secret", baseUrl: server.url });
    await expect(connector.connections!.initiate("user_ada", "linear")).rejects.toThrow(/auth config/i);
  });

  it("lists only the subject's own accounts (user_ids scoping)", async () => {
    const stub = composioStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = composioConnector({ apiKey: "secret", baseUrl: server.url });
    const accounts = await connector.connections!.list("user_ada");
    expect(accounts).toEqual([
      { id: "ca_ada", connector: "composio", toolkit: "gmail", status: "active", createdAt: "2026-07-01T00:00:00Z" },
    ]);
    const listRequest = stub.requests.find((request) => request.path === "/api/v3/connected_accounts");
    expect(listRequest?.query.getAll("user_ids")).toEqual(["user_ada"]);
  });

  it("scopes status lookups to the subject: another user's account reads as null", async () => {
    const stub = composioStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = composioConnector({ apiKey: "secret", baseUrl: server.url });
    expect(await connector.connections!.status("user_ada", "ca_ada")).toMatchObject({ id: "ca_ada", status: "active" });
    expect(await connector.connections!.status("user_ada", "ca_bob")).toBeNull();
  });

  it("refuses to disconnect an account the subject does not own — no delete leaves the process", async () => {
    const stub = composioStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = composioConnector({ apiKey: "secret", baseUrl: server.url });
    await expect(connector.connections!.disconnect("user_ada", "ca_bob")).rejects.toThrow(/not found/i);
    expect(stub.requests.some((request) => request.method === "DELETE")).toBe(false);

    await connector.connections!.disconnect("user_ada", "ca_ada");
    const deletion = stub.requests.find((request) => request.method === "DELETE");
    expect(deletion?.path).toBe("/api/v3/connected_accounts/ca_ada");
  });
});
