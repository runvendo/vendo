import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionGrant, RunContext } from "@vendoai/core";
import { openApiConnector, type ConnectorAuthContext } from "../../src/connectors/openapi.js";
import { createActions } from "../../src/runtime/registry.js";

const grant: PermissionGrant = {
  id: "grt_1",
  subject: "user_ada",
  tool: "openapi_ledger_getAccount",
  descriptorHash: "sha256:test",
  scope: { kind: "tool" },
  duration: "session",
  contextKey: "session_ada",
  source: "chat",
  grantedAt: "2026-08-18T00:00:00.000Z",
};

const ada: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
  grant,
};

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

/** A LIVE host API: the far side of the seam, with nothing stubbed. It answers
 *  the operations the spec below declares and records what actually arrived. */
async function hostApi(): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        ...(typeof req.headers.authorization === "string" ? { authorization: req.headers.authorization } : {}),
        body,
      });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        res.statusCode = 201;
        res.end(JSON.stringify({ created: JSON.parse(body || "null") }));
        return;
      }
      if (req.method === "DELETE") {
        res.end(JSON.stringify({ deleted: url.pathname.split("/").pop() }));
        return;
      }
      res.end(JSON.stringify({ id: url.pathname.split("/").pop(), expand: url.searchParams.get("expand") }));
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  closers.push(async () => {
    server.close();
    server.closeAllConnections();
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** `servers[0]` is deliberately somewhere else: every passing call below proves
 *  the configured baseUrl won. Port 1 refuses instantly when it does not. */
const spec = {
  openapi: "3.1.0",
  info: { title: "Ledger", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:1" }],
  paths: {
    "/accounts": {
      post: {
        operationId: "createAccount",
        summary: "Open an account",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/accounts/{id}": {
      get: {
        operationId: "getAccount",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "expand", in: "query", schema: { type: "string" } },
        ],
        responses: {},
      },
      delete: { operationId: "deleteAccount", responses: {} },
    },
  },
};

describe("openApiConnector", () => {
  it("names every operation under openapi_<name>", async () => {
    const { baseUrl } = await hostApi();
    const descriptors = await openApiConnector({ spec, baseUrl, name: "ledger" }).descriptors();
    expect(descriptors.map((descriptor) => descriptor.name).sort()).toEqual([
      "openapi_ledger_createAccount",
      "openapi_ledger_deleteAccount",
      "openapi_ledger_getAccount",
    ]);
  });

  it("grades risk from the method, exactly as extraction does", async () => {
    const { baseUrl } = await hostApi();
    const descriptors = await openApiConnector({ spec, baseUrl, name: "ledger" }).descriptors();
    const risk = Object.fromEntries(descriptors.map((descriptor) => [descriptor.name, descriptor.risk]));
    expect(risk).toEqual({
      openapi_ledger_createAccount: "ungraded",
      openapi_ledger_deleteAccount: "destructive",
      openapi_ledger_getAccount: "ungraded",
    });
  });

  /** THE SEAM, both halves real: a spec describing a server that is actually
   *  listening, executed through the registry's own dispatch. Nothing is
   *  stubbed on either side, so the request the fixture recorded is the
   *  request the tool made. */
  it("round-trips a real request and response through the registry", async () => {
    const { baseUrl, seen } = await hostApi();
    const actions = createActions({ connectors: [openApiConnector({ spec, baseUrl, name: "ledger" })] });

    const read = await actions.execute(
      { id: "1", tool: "openapi_ledger_getAccount", args: { id: "acc_1", expand: "owner" } },
      ada,
    );
    expect(read).toEqual({ status: "ok", output: { id: "acc_1", expand: "owner" } });

    const written = await actions.execute(
      { id: "2", tool: "openapi_ledger_createAccount", args: { body: { name: "Ada" } } },
      ada,
    );
    expect(written).toEqual({ status: "ok", output: { created: { name: "Ada" } } });

    expect(seen).toEqual([
      { method: "GET", url: "/accounts/acc_1?expand=owner", body: "" },
      { method: "POST", url: "/accounts", body: JSON.stringify({ name: "Ada" }) },
    ]);
  });

  it("sends baseUrl instead of the spec's servers[0]", async () => {
    const { baseUrl, seen } = await hostApi();
    const connector = openApiConnector({ spec, baseUrl, name: "ledger" });
    await connector.execute({ id: "1", tool: "openapi_ledger_deleteAccount", args: { id: "acc_9" } }, ada);
    expect(seen).toHaveLength(1);

    const unconfigured = openApiConnector({ spec, name: "ledger" });
    const outcome = await unconfigured.execute(
      { id: "2", tool: "openapi_ledger_deleteAccount", args: { id: "acc_9" } },
      ada,
    );
    expect(outcome).toMatchObject({ status: "error", error: { code: "network-error" } });
    expect(seen).toHaveLength(1);
  });

  it("resolves headers per call, with the acting principal and grant", async () => {
    const { baseUrl, seen } = await hostApi();
    const auths: ConnectorAuthContext[] = [];
    const connector = openApiConnector({
      spec,
      baseUrl,
      name: "ledger",
      headers: (auth) => {
        auths.push(auth);
        return { authorization: `Bearer ${auth.principal?.subject ?? "anon"}` };
      },
    });

    await connector.execute({ id: "1", tool: "openapi_ledger_getAccount", args: { id: "acc_1" } }, ada);

    expect(auths).toEqual([{ principal: ada.principal, presence: "present", grant }]);
    expect(seen[0]?.authorization).toBe("Bearer user_ada");
  });

  it("reads a YAML document as readily as an object", async () => {
    const { baseUrl, seen } = await hostApi();
    const connector = openApiConnector({
      spec: [
        "openapi: 3.1.0",
        "info: { title: Ledger, version: 1.0.0 }",
        "paths:",
        "  /accounts/{id}:",
        "    get:",
        "      operationId: getAccount",
        "      responses: {}",
      ].join("\n"),
      baseUrl,
      name: "ledger",
    });
    const outcome = await connector.execute(
      { id: "1", tool: "openapi_ledger_getAccount", args: { id: "acc_2" } },
      ada,
    );
    expect(outcome).toEqual({ status: "ok", output: { id: "acc_2", expand: null } });
    expect(seen[0]?.url).toBe("/accounts/acc_2");
  });

  it("reports an unknown tool rather than calling anything", async () => {
    const { baseUrl, seen } = await hostApi();
    const connector = openApiConnector({ spec, baseUrl, name: "ledger" });
    expect(await connector.execute({ id: "1", tool: "openapi_ledger_nope", args: {} }, ada))
      .toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(seen).toHaveLength(0);
  });
});
