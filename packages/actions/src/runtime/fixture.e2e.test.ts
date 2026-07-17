import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VENDO_OVERRIDES_FORMAT, toolOutcomeSchema, type PermissionGrant, type RunContext, type ToolOutcome } from "@vendoai/core";
import type { ExtractedTool } from "../formats.js";
import { vendoSync } from "../sync/index.js";
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
      if (response.ok) {
        await warmRoutes(deadline);
        return;
      }
    } catch {
      // Next is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Fixture did not become ready\n${serverOutput}`);
}

/** Next dev compiles API routes lazily; under parallel-suite CPU load a first
 *  request to an uncompiled dynamic route can 500 with an HTML error page.
 *  Touch each route family once (any status counts — we only need the compile)
 *  and retry the transient dev-compile 500s so tests assert against a warm
 *  server instead of the compiler. */
async function warmRoutes(deadline: number): Promise<void> {
  const paths = ["/api/login", "/api/invoices", "/api/invoices/inv_warmup", "/api/customers", "/api/openapi"];
  for (const path of paths) {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}${path}`);
        // 500 with an HTML body is the dev compiler mid-flight; anything else
        // (2xx/4xx/JSON 500) means the route module is compiled and serving.
        if (response.status !== 500) break;
        const body = await response.text();
        if (!body.startsWith("<!DOCTYPE")) break;
      } catch {
        // Server hiccup while compiling — retry below.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function stopFixture(): Promise<void> {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  // Collect this run's isolated dist dir (see FIXTURE_DIST_DIR at spawn).
  await rm(join(fixtureDir, `.next-actions-e2e-${process.pid}`), { recursive: true, force: true });
}

async function startFixture(): Promise<void> {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverOutput = "";
  const fixtureChild = spawn(nextBin, ["dev", "-p", String(port)], {
    cwd: fixtureDir,
    // FIXTURE_DIST_DIR: host-app's next.config gives each concurrent consumer
    // its own dist dir (see the comment there); the previous default `.next`
    // shared a build cache with the other harnesses that boot this fixture.
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FIXTURE_DIST_DIR: `.next-actions-e2e-${process.pid}` },
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
  try {
    await startFixture();
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.startsWith("Fixture exited early")) throw cause;
    await stopFixture();
    await startFixture();
  }
}, 120_000);

afterAll(stopFixture);

beforeEach(async () => {
  const response = await fetch(`${baseUrl}/fixture/reset`, { method: "POST" });
  expect(response.status).toBe(200);
});

describe("fixture route execution", () => {
  it("executes the full sync to overrides to runtime chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-actions-chain-"));
    const out = join(root, ".vendo");
    try {
      await mkdir(out);
      await writeFile(join(out, "overrides.json"), JSON.stringify({
        format: VENDO_OVERRIDES_FORMAT,
        tools: {
          host_listCustomers: { disabled: true },
          host_listInvoices: { description: "Invoices from the synced fixture" },
        },
      }));
      await vendoSync({ root: fixtureDir, out });

      const cookie = await loginCookie();
      const ctx: RunContext = { ...presentBase, requestHeaders: { cookie } };
      const actions = createActions({ dir: root, baseUrl });
      expect(await actions.descriptors()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "host_listInvoices", description: "Invoices from the synced fixture" }),
      ]));
      expect((await actions.descriptors()).some((descriptor) => descriptor.name === "host_listCustomers")).toBe(false);
      await expect(actions.execute({ id: "sync-1", tool: "host_listInvoices", args: {} }, ctx)).resolves.toMatchObject({
        status: "ok",
        output: { invoices: expect.any(Array) },
      });
      await expect(actions.execute({ id: "sync-2", tool: "host_listCustomers", args: {} }, ctx)).resolves.toMatchObject({
        status: "error",
        error: { code: "not-found" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("keeps extraction-disabled routes out of the runtime surface (fail-closed)", async () => {
    // Real extraction over the real host tree: /api/export-data cannot be classified,
    // so sync emits it disabled with a note (04 §1). The runtime must never list or
    // execute it — a route the scanner can't classify is never silently auto-allowed.
    const root = await mkdtemp(join(tmpdir(), "vendo-actions-failclosed-"));
    const out = join(root, ".vendo");
    try {
      await vendoSync({ root: fixtureDir, out });
      const written = JSON.parse(await readFile(join(out, "tools.json"), "utf8")) as {
        tools: Array<{ name: string; disabled?: boolean; note?: string }>;
      };
      const unclassified = written.tools.find((tool) => tool.name === "host_export_data_unclassified");
      expect(unclassified).toMatchObject({ disabled: true });
      expect(unclassified?.note).toContain("enable only after review");

      const cookie = await loginCookie();
      const ctx: RunContext = { ...presentBase, requestHeaders: { cookie } };
      const actions = createActions({ dir: root, baseUrl });
      const names = (await actions.descriptors()).map((descriptor) => descriptor.name);
      expect(names).not.toContain("host_export_data_unclassified");
      // An enabled sibling from the very same extraction is present and runs.
      expect(names).toContain("host_listInvoices");

      await expect(
        actions.execute({ id: "fc-1", tool: "host_export_data_unclassified", args: {} }, ctx),
      ).resolves.toMatchObject({ status: "error", error: { code: "not-found" } });
      await expect(
        actions.execute({ id: "fc-2", tool: "host_listInvoices", args: {} }, ctx),
      ).resolves.toMatchObject({ status: "ok", output: { invoices: expect.any(Array) } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards present request headers to the real host and never in away mode", async () => {
    const echoTool: ExtractedTool = {
      name: "host_echo",
      description: "Echo request headers",
      inputSchema: { type: "object" },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/fixture/echo", argsIn: "query" },
    };

    // Present: ctx.requestHeaders (cookie/authorization + a custom header) reach the host.
    const present: RunContext = {
      ...presentBase,
      requestHeaders: { cookie: "fixture_session=user_ada", authorization: "Bearer inbound", "x-present": "forwarded" },
    };
    const presentActions = createActions({ tools: [echoTool], baseUrl });
    const presentEcho = okOutput(
      await presentActions.execute({ id: "e1", tool: "host_echo", args: { q: "1" } }, present),
    ) as { headers: Record<string, string>; query: Record<string, string> };
    expect(presentEcho.headers.cookie).toBe("fixture_session=user_ada");
    expect(presentEcho.headers.authorization).toBe("Bearer inbound");
    expect(presentEcho.headers["x-present"]).toBe("forwarded");
    expect(presentEcho.query).toEqual({ q: "1" });

    // Away: only the host's actAs AuthMaterial.headers ride the request. The inbound
    // present material must NOT leak onto an away call.
    const grant: PermissionGrant = {
      id: "grt_echo",
      subject: "user_ada",
      tool: "host_echo",
      descriptorHash: "sha256:echo",
      scope: { kind: "tool" },
      duration: "standing",
      source: "chat",
      grantedAt: "2026-07-11T00:00:00.000Z",
    };
    const away: ActionsRunContext = {
      ...presentBase,
      presence: "away",
      grant,
      requestHeaders: { cookie: "fixture_session=POISON", authorization: "Bearer present-leak", "x-present": "leak" },
    };
    const awayActions = createActions({
      tools: [echoTool],
      baseUrl,
      actAs: async () => ({ headers: { authorization: "Bearer away-token", "x-actas": "yes" } }),
    });
    const awayEcho = okOutput(
      await awayActions.execute({ id: "e2", tool: "host_echo", args: {} }, away),
    ) as { headers: Record<string, string> };
    expect(awayEcho.headers.authorization).toBe("Bearer away-token");
    expect(awayEcho.headers["x-actas"]).toBe("yes");
    expect(awayEcho.headers["x-present"]).toBeUndefined();
    expect(awayEcho.headers.cookie).toBeUndefined();
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
