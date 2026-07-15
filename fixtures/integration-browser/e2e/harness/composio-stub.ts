/** A loopback Composio backend stub for the connected-accounts browser leg:
 * the REAL composioConnector in the composed umbrella talks to this over HTTP
 * exactly as it would to backend.composio.dev. One gmail tool; `user_ada`
 * starts with an active connection, everyone else connects through the link
 * flow (which activates immediately — the shortest honest OAuth completion). */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface StubAccount {
  id: string;
  toolkit: { slug: string };
  status: string;
  user_id: string;
  created_at: string;
}

const SEED: StubAccount[] = [
  { id: "ca_ada", toolkit: { slug: "gmail" }, status: "ACTIVE", user_id: "user_ada", created_at: "2026-07-01T00:00:00Z" },
];

export interface ComposioStub {
  url: string;
  reset(): void;
  close(): Promise<void>;
}

export async function startComposioStub(): Promise<ComposioStub> {
  let accounts: StubAccount[] = structuredClone(SEED);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = chunks.length > 0
      ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
      : undefined;

    // The page the connect card's popup lands on.
    if (req.method === "GET" && url.pathname.startsWith("/oauth/")) {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>Connected</title><p>Account connected — you can close this window.</p>");
      return;
    }

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
        items: url.searchParams.get("toolkit_slug") === "gmail" ? [{ id: "ac_gmail", status: "ENABLED" }] : [],
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v3/connected_accounts/link") {
      const subject = (body as { user_id?: string } | undefined)?.user_id ?? "unknown";
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
      res.end(JSON.stringify({
        redirect_url: `${origin}/oauth/${id}`,
        connected_account_id: id,
      }));
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
      const subject = (body as { user_id?: string } | undefined)?.user_id ?? "unknown";
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

  const server: Server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      res.statusCode = 500;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: origin,
    reset() {
      accounts = structuredClone(SEED);
    },
    async close() {
      // Kill keep-alive sockets FIRST: server.close() waits for open
      // connections, so the graceful close would otherwise never resolve.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
