import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toolOutcomeSchema, type PermissionGrant, type RunContext, type ToolOutcome } from "@vendoai/core";
import type { ExtractedTool } from "../formats.js";
import { createActions, type ActionsRunContext } from "./registry.js";

const fixtureDir = fileURLToPath(new URL("../../../../fixtures/host-app/", import.meta.url));
const nextBin = join(fixtureDir, "node_modules", ".bin", "next");

let child: ChildProcessWithoutNullStreams | undefined;
let baseUrl = "";
let serverOutput = "";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate fixture port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForFixture(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(`Fixture exited early (${child?.exitCode})\n${serverOutput}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Next is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Fixture did not become ready\n${serverOutput}`);
}

async function stopFixture(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([exited, timeout]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const routeTools: ExtractedTool[] = [
  {
    name: "host_invoices_list",
    description: "List invoices",
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  },
  {
    name: "host_invoices_create",
    description: "Create invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "POST", path: "/api/invoices", argsIn: "body" },
  },
  {
    name: "host_invoices_get",
    description: "Get invoice",
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices/{id}", argsIn: "query" },
  },
  {
    name: "host_invoices_update",
    description: "Update invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "PATCH", path: "/api/invoices/{id}", argsIn: "body" },
  },
  {
    name: "host_invoices_delete",
    description: "Delete invoice",
    inputSchema: { type: "object" },
    risk: "destructive",
    binding: { kind: "route", method: "DELETE", path: "/api/invoices/{id}", argsIn: "query" },
  },
  {
    name: "host_invoices_send",
    description: "Send invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "POST", path: "/api/invoices/{id}/send", argsIn: "body" },
  },
];

const presentBase: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "fixture_session",
};

function okOutput(outcome: ToolOutcome): unknown {
  expect(toolOutcomeSchema.safeParse(outcome).success).toBe(true);
  expect(outcome.status).toBe("ok");
  return outcome.status === "ok" ? outcome.output : undefined;
}

async function loginCookie(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "user_ada" }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Fixture login did not return a cookie");
  return cookie;
}

beforeAll(async () => {
  await access(nextBin);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const fixtureChild = spawn(nextBin, ["dev", "-p", String(port)], {
    cwd: fixtureDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child = fixtureChild;
  fixtureChild.stdout.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000);
  });
  fixtureChild.stderr.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000);
  });
  await waitForFixture();
}, 120_000);

afterAll(stopFixture);

beforeEach(async () => {
  const response = await fetch(`${baseUrl}/fixture/reset`, { method: "POST" });
  expect(response.status).toBe(200);
});

describe("fixture route execution", () => {
  it("uses the present session for list/create/get/update/send/delete", async () => {
    const cookie = await loginCookie();
    const ctx: RunContext = { ...presentBase, requestHeaders: { cookie } };
    const actions = createActions({ tools: routeTools, baseUrl });

    const initial = okOutput(await actions.execute({ id: "1", tool: "host_invoices_list", args: {} }, ctx)) as {
      invoices: Array<{ id: string }>;
    };
    expect(initial.invoices).toHaveLength(8);

    const created = okOutput(await actions.execute({
      id: "2",
      tool: "host_invoices_create",
      args: { customerId: "cus_ada", amountCents: 7777, memo: "Runtime e2e" },
    }, ctx)) as { invoice: { id: string; memo: string } };
    expect(created.invoice).toMatchObject({ id: "inv_9001", memo: "Runtime e2e" });

    const listed = okOutput(await actions.execute({ id: "3", tool: "host_invoices_list", args: {} }, ctx)) as {
      invoices: Array<{ id: string }>;
    };
    expect(listed.invoices.some((invoice) => invoice.id === "inv_9001")).toBe(true);

    const fetched = okOutput(await actions.execute({ id: "4", tool: "host_invoices_get", args: { id: "inv_9001" } }, ctx));
    expect(fetched).toMatchObject({ invoice: { id: "inv_9001" } });
    const updated = okOutput(await actions.execute({
      id: "5",
      tool: "host_invoices_update",
      args: { id: "inv_9001", memo: "Updated through runtime" },
    }, ctx));
    expect(updated).toMatchObject({ invoice: { id: "inv_9001", memo: "Updated through runtime" } });
    const sent = okOutput(await actions.execute({ id: "6", tool: "host_invoices_send", args: { id: "inv_9001" } }, ctx));
    expect(sent).toMatchObject({ invoice: { id: "inv_9001", status: "open" } });
    expect(okOutput(await actions.execute({ id: "7", tool: "host_invoices_delete", args: { id: "inv_9001" } }, ctx))).toEqual({ ok: true });
  });

  it("surfaces fixture authentication failures as http-error outcomes", async () => {
    const actions = createActions({ tools: routeTools, baseUrl });
    const outcome = await actions.execute({ id: "1", tool: "host_invoices_list", args: {} }, presentBase);
    expect(toolOutcomeSchema.parse(outcome)).toMatchObject({
      status: "error",
      error: { code: "http-error", message: expect.stringContaining("401") },
    });
  });

  it("handles every away-mode authentication branch", async () => {
    const grant: PermissionGrant = {
      id: "grt_fixture",
      subject: "user_ada",
      tool: "host_invoices_list",
      descriptorHash: "sha256:fixture",
      scope: { kind: "tool" },
      duration: "standing",
      source: "chat",
      grantedAt: "2026-07-11T00:00:00.000Z",
    };
    const away: ActionsRunContext = { ...presentBase, presence: "away", grant };

    const unavailable = await createActions({ tools: routeTools, baseUrl }).execute(
      { id: "1", tool: "host_invoices_list", args: {} },
      away,
    );
    expect(unavailable).toMatchObject({ status: "error", error: { code: "not-implemented", message: "away execution isn't set up for this product" } });

    const cookie = await loginCookie();
    const working = createActions({ tools: routeTools, baseUrl, actAs: async () => ({ headers: { cookie } }) });
    const output = okOutput(await working.execute({ id: "2", tool: "host_invoices_list", args: {} }, away)) as { invoices: unknown[] };
    expect(output.invoices).toHaveLength(8);

    const declined = createActions({ tools: routeTools, baseUrl, actAs: async () => null });
    await expect(declined.execute({ id: "3", tool: "host_invoices_list", args: {} }, away)).resolves.toMatchObject({
      status: "error",
      error: { code: "not-implemented", message: "the host declined away execution for this action" },
    });

    const noGrant: ActionsRunContext = { ...presentBase, presence: "away" };
    await expect(working.execute({ id: "4", tool: "host_invoices_list", args: {} }, noGrant)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation", message: "away execution requires a captured grant" },
    });
  });

  it("executes OpenAPI bindings using the body-key convention", async () => {
    const cookie = await loginCookie();
    const ctx: RunContext = { ...presentBase, requestHeaders: { cookie } };
    const tools: ExtractedTool[] = [
      {
        name: "openapi_create_invoice",
        description: "Create invoice",
        inputSchema: { type: "object" },
        risk: "write",
        binding: { kind: "openapi", operationId: "createInvoice", method: "POST", path: "/api/invoices" },
      },
      {
        name: "openapi_update_invoice",
        description: "Update invoice",
        inputSchema: { type: "object" },
        risk: "write",
        binding: { kind: "openapi", operationId: "updateInvoice", method: "PATCH", path: "/api/invoices/{id}" },
      },
    ];
    const actions = createActions({ tools, baseUrl });
    const created = okOutput(await actions.execute({
      id: "1",
      tool: "openapi_create_invoice",
      args: { body: { customerId: "cus_ada", amountCents: 4242, memo: "OpenAPI" } },
    }, ctx));
    expect(created).toMatchObject({ invoice: { id: "inv_9001", memo: "OpenAPI" } });
    const updated = okOutput(await actions.execute({
      id: "2",
      tool: "openapi_update_invoice",
      args: { id: "inv_9001", body: { memo: "OpenAPI updated" } },
    }, ctx));
    expect(updated).toMatchObject({ invoice: { id: "inv_9001", memo: "OpenAPI updated" } });
  });
});
