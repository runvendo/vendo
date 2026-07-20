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

/** A lazy-mode stub: auth_configs (page-numbered, lying next_cursor), per-slug
 * toolkit metadata, and per-toolkit tools — counting tool fetches so the
 * no-eager-load and cache asserts are direct. */
function lazyStub() {
  const toolFetches: string[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://stub");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v3/auth_configs") {
      res.end(JSON.stringify({
        items: [
          { id: "ac_gmail", toolkit: { slug: "gmail" }, status: "ENABLED" },
          { id: "ac_slack", toolkit: { slug: "slack" }, status: "ENABLED" },
        ],
        total_items: 2,
        next_cursor: null,
      }));
      return;
    }
    const toolkitMatch = /^\/api\/v3\/toolkits\/([^/]+)$/.exec(url.pathname);
    if (toolkitMatch) {
      const slug = toolkitMatch[1]!;
      if (slug === "slack") {
        // No metadata for slack — the static fallback covers it.
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      res.end(JSON.stringify({
        slug,
        name: "Gmail",
        meta: { description: "Gmail is Google's email service for sending and reading email" },
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v3/tools/execute/GMAIL_DO_THING") {
      res.end(JSON.stringify({ successful: true, data: { ok: 1 } }));
      return;
    }
    if (url.pathname === "/api/v3/tools") {
      const toolkit = url.searchParams.get("toolkit_slug")!;
      toolFetches.push(toolkit);
      res.end(JSON.stringify({
        items: [{
          slug: `${toolkit.toUpperCase()}_DO_THING`,
          toolkit_slug: toolkit,
          description: `${toolkit} tool`,
          input_parameters: { type: "object" },
        }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${url.pathname}` } }));
  };
  return { handler, toolFetches: () => toolFetches };
}

const ctx = { principal: { kind: "user" as const, subject: "user_ada" }, venue: "chat" as const, presence: "present" as const, sessionId: "s1" };

describe("composio lazy mode (no apps)", () => {
  it("loads NOTHING eagerly: descriptors() is empty and no /tools fetch happens", async () => {
    const stub = lazyStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });

    await expect(connector.descriptors()).resolves.toEqual([]);
    expect(stub.toolFetches()).toEqual([]);
  });

  it("serves the discovery index with provider descriptions and static fallback", async () => {
    const stub = lazyStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });

    await expect(connector.discoveryIndex!()).resolves.toEqual([
      { toolkit: "gmail", label: "Gmail", description: "Gmail is Google's email service for sending and reading email" },
      { toolkit: "slack", description: "Post messages and interact with Slack channels" }, // static fallback
    ]);
  });

  it("expands only requested, connectable toolkits; caches; executes expanded tools", async () => {
    const stub = lazyStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url });

    await expect(connector.expandToolkits!(["gmail", "not-a-toolkit"])).resolves.toBe(true);
    const names = (await connector.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toEqual(["gmail_GMAIL_DO_THING"]);

    // Second expand of the same toolkit: nothing new, no refetch.
    await expect(connector.expandToolkits!(["gmail"])).resolves.toBe(false);
    await connector.descriptors();
    expect(stub.toolFetches()).toEqual(["gmail"]);

    // The expanded tool dispatches through the normal execute path (its
    // normalized→raw mapping was rebuilt by descriptors()).
    const outcome = await connector.execute({ id: "c1", tool: "gmail_GMAIL_DO_THING", args: {} }, ctx);
    expect(outcome.status).not.toBe("error");
  });

  it("apps mode is unchanged: eager, exactly those apps, index mirrors apps", async () => {
    const stub = lazyStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);
    const connector = composioConnector({ apiKey: "key", baseUrl: server.url, apps: ["gmail"] });

    const names = (await connector.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toEqual(["gmail_GMAIL_DO_THING"]);
    expect(stub.toolFetches()).toEqual(["gmail"]);

    await expect(connector.discoveryIndex!()).resolves.toEqual([
      { toolkit: "gmail", label: "Gmail", description: "Gmail is Google's email service for sending and reading email" },
    ]);
    // apps mode never lazily expands
    await expect(connector.expandToolkits!(["slack"])).resolves.toBe(false);
  });
});
