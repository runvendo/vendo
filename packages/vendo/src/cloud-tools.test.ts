import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "@vendoai/core";
import { cloudTools } from "./cloud-tools.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

const GMAIL_TOOL = {
  slug: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
  description: "Send email",
  inputParameters: { type: "object" },
  tags: [],
};

function consoleStub(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("cloudTools", () => {
  it("loads descriptors through the console with BYO-identical names and risk", async () => {
    const stub = consoleStub(() => ({ body: { tools: [GMAIL_TOOL] } }));
    const connector = cloudTools({ apiKey: "vnd_key", baseUrl: "https://cloud.test", fetch: stub.fetchImpl });

    const descriptors = await connector.descriptors();
    expect(descriptors).toHaveLength(1);
    // Same normalization + curated risk the BYO composioConnector applies.
    expect(descriptors[0]!.name).toBe("gmail_GMAIL_SEND_EMAIL");
    expect(descriptors[0]!.risk).toBe("write");
    expect(stub.requests[0]!.url).toBe("https://cloud.test/api/v1/tools");
  });

  it("scopes the tool list with apps", async () => {
    const stub = consoleStub(() => ({ body: { tools: [] } }));
    const connector = cloudTools({ apiKey: "vnd_key", baseUrl: "https://cloud.test", apps: ["gmail", "slack"], fetch: stub.fetchImpl });
    await connector.descriptors();
    expect(stub.requests[0]!.url).toBe("https://cloud.test/api/v1/tools?toolkits=gmail%2Cslack");
  });

  it("degrades to zero tools (never throws) when the broker is missing or unconfigured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const status of [404, 503, 401]) {
        const stub = consoleStub(() => ({ status, body: { error: { message: "nope" } } }));
        const connector = cloudTools({ apiKey: "vnd_key", baseUrl: "https://cloud.test", fetch: stub.fetchImpl });
        await expect(connector.descriptors()).resolves.toEqual([]);
      }
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("executes as the principal and passes the wire outcome through with identity", async () => {
    const stub = consoleStub((url) =>
      url.endsWith("/api/v1/tools")
        ? { body: { tools: [GMAIL_TOOL] } }
        : { body: { outcome: { status: "ok", output: { id: "msg_1" } } } });
    const connector = cloudTools({ apiKey: "vnd_key", baseUrl: "https://cloud.test", fetch: stub.fetchImpl });
    await connector.descriptors();

    const outcome = await connector.execute({ id: "call_1", tool: "gmail_GMAIL_SEND_EMAIL", args: { to: "a@b.c" } }, ctx);
    expect(outcome).toMatchObject({
      status: "ok",
      output: { id: "msg_1" },
      connectorAccount: { connector: "composio", toolkit: "gmail", entityId: "user_ada", credential: "per-principal" },
    });
    const execute = stub.requests.find((request) => request.url.endsWith("/tools/execute"))!;
    expect(execute.body).toEqual({
      subject: "user_ada",
      toolkit: "gmail",
      tool: "GMAIL_SEND_EMAIL",
      arguments: { to: "a@b.c" },
    });
  });

  it("passes connect-required outcomes through so the connect card renders", async () => {
    const stub = consoleStub((url) =>
      url.endsWith("/api/v1/tools")
        ? { body: { tools: [GMAIL_TOOL] } }
        : {
            body: {
              outcome: {
                status: "connect-required",
                connect: { connector: "composio", toolkit: "gmail", message: "Connect your gmail account to run GMAIL_SEND_EMAIL." },
              },
            },
          });
    const connector = cloudTools({ apiKey: "vnd_key", baseUrl: "https://cloud.test", fetch: stub.fetchImpl });
    await connector.descriptors();

    const outcome = await connector.execute({ id: "call_1", tool: "gmail_GMAIL_SEND_EMAIL", args: {} }, ctx);
    expect(outcome).toMatchObject({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail" },
    });
  });

  it("answers unknown tools and broker failures as error outcomes, never throws", async () => {
    const stub = consoleStub((url) =>
      url.endsWith("/api/v1/tools")
        ? { body: { tools: [GMAIL_TOOL] } }
        : { status: 500, body: { error: { message: "broker exploded" } } });
    const connector = cloudTools({ apiKey: "vnd_key", baseUrl: "https://cloud.test", fetch: stub.fetchImpl });
    await connector.descriptors();

    await expect(connector.execute({ id: "c", tool: "nope_TOOL", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
    await expect(connector.execute({ id: "c", tool: "gmail_GMAIL_SEND_EMAIL", args: {} }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "connector-error", message: "broker exploded" },
    });
  });
});
