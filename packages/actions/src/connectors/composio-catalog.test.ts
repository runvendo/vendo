import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { composioConnector } from "./composio.js";

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

/** An auth-configs stub: two pages, a DISABLED config, and a duplicate
 * toolkit, counting requests so the cache assert is direct. */
function authConfigsStub() {
  let requests = 0;
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://stub");
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && url.pathname === "/api/v3/auth_configs") {
      requests += 1;
      if (url.searchParams.get("cursor") === "page2") {
        res.end(JSON.stringify({
          items: [
            { id: "ac_slack_2", toolkit: { slug: "slack" }, status: "ENABLED" }, // duplicate toolkit
            { id: "ac_linear", toolkit: { slug: "linear" }, status: "ENABLED" },
          ],
        }));
        return;
      }
      res.end(JSON.stringify({
        items: [
          { id: "ac_gmail", toolkit: { slug: "gmail" }, status: "ENABLED" },
          { id: "ac_slack", toolkit: { slug: "slack" }, status: "ENABLED" },
          { id: "ac_notion", toolkit: { slug: "notion" }, status: "DISABLED" },
        ],
        next_cursor: "page2",
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${url.pathname}` } }));
  };
  return { handler, requestCount: () => requests };
}

describe("composio listConnectable", () => {
  it("returns the apps scoping verbatim without touching Composio", async () => {
    const stub = authConfigsStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url, apps: ["gmail", "slack"] });

    await expect(connector.connections!.listConnectable!()).resolves.toEqual([
      { toolkit: "gmail" },
      { toolkit: "slack" },
    ]);
    expect(stub.requestCount()).toBe(0);
  });

  it("walks auth configs when apps is omitted: paginated, deduped, DISABLED skipped", async () => {
    const stub = authConfigsStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });

    await expect(connector.connections!.listConnectable!()).resolves.toEqual([
      { toolkit: "gmail" },
      { toolkit: "slack" },
      { toolkit: "linear" },
    ]);
    expect(stub.requestCount()).toBe(2);
  });

  it("serves repeat calls from the cache", async () => {
    const stub = authConfigsStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });

    await connector.connections!.listConnectable!();
    await connector.connections!.listConnectable!();
    expect(stub.requestCount()).toBe(2); // both pages once, no second walk
  });

  it("surfaces an auth-configs failure instead of an empty catalog", async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "boom" } }));
    });
    closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });

    await expect(connector.connections!.listConnectable!()).rejects.toThrow(
      "Composio auth-configs request failed with 500: boom",
    );
  });
});
