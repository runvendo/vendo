import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActAs, PermissionGrant, Principal } from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { extractServerActions } from "@vendoai/actions/sync";
import type { VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../../src/server.js";
import { doctorErrorCodes, doctorFixRef } from "../../src/cli/doctor-codes.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { CLI_VERSION } from "../../src/cli/shared.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

/** Existing checks are about static wiring + the HTTP probes, not the new
 *  live-turn/cloud/dev-server-probe surface (those get dedicated tests below).
 *  This wrapper stubs the new seams so the legacy assertions stay focused:
 *  a canned successful live turn, no cloud key, non-interactive. */
async function doctor(options: Parameters<typeof runDoctor>[0]): Promise<number> {
  return runDoctor({
    env: {},
    interactive: false,
    liveTurn: async () => ({
      attempted: true,
      ok: true,
      rung: "env-key",
      credential: "explicit ANTHROPIC_API_KEY (anthropic)",
      reply: "ok",
      elapsedMs: 1,
    }),
    cloudProbe: async () => ({ present: false, ok: false, unlocks: ["a starter allowance"] }),
    // No registry round-trip from the suite: the npm-latest hint is its own
    // test (doctor-version-skew.test.ts).
    npmLatest: async () => null,
    ...options,
  });
}

async function healthy(base?: string): Promise<string> {
  // A caller-supplied base nests the fixture (e.g. inside a workspace dir the
  // caller creates and cleans up); the default is a standalone temp root.
  const root = base ?? (await mkdtemp(join(tmpdir(), "vendo-doctor-")));
  if (base === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }));
  else await mkdir(root, { recursive: true });
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({ dependencies: { "@vendoai/vendo": "0.3.0", next: "16" } }));
  await write("app/layout.tsx", "export default ({children}) => <VendoProvider>{children}<VendoOverlay /></VendoProvider>;");
  await write("app/api/vendo/[...vendo]/route.ts", "export const GET = () => {};\n");
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

async function expressHost(wired: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-express-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({
    dependencies: { "@vendoai/vendo": "0.3.0", express: "5.0.0" },
  }));
  if (wired) {
    await write("src/server.ts", 'import { createVendo } from "@vendoai/vendo/server";\ncreateVendo({ model, principal });\n');
    await write("src/client.tsx", "export const App = () => <VendoProvider><main /><VendoOverlay /></VendoProvider>;\n");
  } else {
    await write("src/notes.ts", "/* TODO: import createVendo from @vendoai/vendo/server and render <VendoRoot> */\n");
  }
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

/** A host doctor cannot pattern-match: no next, no express (Cloudflare
 *  Worker + Vite was the field case — E-WIRE-003/004 false positives). */
async function customHost(wired: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-custom-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({
    dependencies: { "@vendoai/vendo": "0.3.0", vite: "6.0.0" },
  }));
  if (wired) {
    await write("src/worker.ts", 'import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ model, principal });\n');
    await write("src/app.tsx", "export const App = () => <VendoProvider><main /><VendoOverlay /></VendoProvider>;\n");
  } else {
    await write("src/worker.ts", "export default { fetch: () => new Response('ok') };\n");
  }
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

function output(): { logs: string[]; errors: string[]; sink: { log(message: string): void; error(message: string): void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    sink: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
  };
}

function successfulProbeFetch(
  blocks: Record<string, unknown> = { store: true, sandbox: "cloud" },
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/status")) {
      return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks });
    }
    if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
    if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
    if (url.endsWith("/doctor/machines")) {
      return Response.json({ scheduleCallerConfigured: false, machines: [] });
    }
    return Response.json({ error: { message: "unexpected probe" } }, { status: 404 });
  });
}

async function bridge(vendo: Vendo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const response = await vendo.handler(new Request(`http://${req.headers.host}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    ...(body === undefined ? {} : { body }),
  }));
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function liveHost(options: { configureBaseUrl?: boolean; actAs?: boolean } = {}): Promise<{
  root: string;
  url: string;
  actAs: ReturnType<typeof vi.fn<ActAs>>;
}> {
  const root = await healthy();
  const memory = memoryStoreAdapter();
  const store: VendoStore = {
    ...memory,
    async close() {},
    raw: () => undefined,
  };
  let vendo: Vendo | undefined;
  const server = createServer((req, res) => {
    if (vendo === undefined) {
      res.statusCode = 503;
      res.end("Vendo is starting");
      return;
    }
    void bridge(vendo, req, res).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "bridge failed");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("doctor fixture did not bind TCP");
  const origin = `http://127.0.0.1:${address.port}`;
  if (options.configureBaseUrl !== false) vi.stubEnv("VENDO_BASE_URL", origin);
  else vi.stubEnv("VENDO_BASE_URL", "");

  const minted = new Map<string, string>();
  const actAs = vi.fn<ActAs>(async (principal) => {
    const token = `Bearer doctor-${principal.subject}`;
    minted.set(token, principal.subject);
    return { headers: { authorization: token } };
  });
  const principal = async (request: Request): Promise<Principal> => ({
    kind: "user",
    subject: minted.get(request.headers.get("authorization") ?? "") ?? "user_doctor",
  });
  vendo = createVendo({
    model: {} as LanguageModel,
    principal,
    store,
    // This fixture stands in for the dev server `vendo doctor` targets, and the
    // probes it drives are mounted only in a development composition. `next dev`
    // sets NODE_ENV=development, which sets this; vitest sets NODE_ENV=test, so
    // the fixture says it outright.
    development: true,
    ...(options.actAs === false ? {} : { actAs }),
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  });
  return { root, url: `${origin}/api/vendo`, actAs };
}

describe("vendo doctor", () => {
  it("checks Express server and client wiring instead of Next files", async () => {
    const fetchImpl = successfulProbeFetch();
    const messages = output();
    expect(await doctor({
      targetDir: await expressHost(true),
      fetchImpl,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
    expect(messages.logs).toContain("ok: Express server is wired");
    expect(messages.logs).toContain("ok: <VendoProvider> wraps the client");
    expect(messages.logs.join("\n")).not.toContain("catch-all handler");
  });

  it("returns one when an Express host is missing server and client wiring", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await expressHost(false),
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toEqual(expect.arrayContaining([
      "broken: Express server is not wired with createVendo from @vendoai/vendo/server",
      "broken: Express client is not wrapped in <VendoProvider>",
    ]));
  });

  it("judges an unknown-framework host by its wiring, not Next's file layout", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await customHost(true),
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
    const log = messages.logs.join("\n");
    expect(log).not.toContain("catch-all handler");
    expect(log).toContain("ok: createVendo server wiring found");
  });

  it("an unknown-framework host with no createVendo anywhere fails the generic wiring check", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await customHost(false),
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toContain("no createVendo server wiring found");
    expect(messages.errors.join("\n")).not.toContain("app/api/vendo/[...vendo]/route.ts");
  });

  it("fails when the extracted tool surface has zero live tools (the agent cannot act on the host)", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_internal_hook", description: "d", inputSchema: { type: "object" }, risk: "write", disabled: true,
        binding: { kind: "route", method: "POST", path: "/api/hook", argsIn: "body" },
      }],
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toMatch(/zero live host tools/i);
  });

  it("warns (does not fail) when extraction produced zero tools — connector-only hosts are legitimate", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: "vendo/tools@3", tools: [] }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors.join("\n")).toMatch(/tool surface is empty/i);
  });

  it("a live tool surface passes the zero-live-tools check", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
  });

  it("grades the live-surface check through an overrides.json disable too", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
        srcHash: "sha256:abc",
      }],
    }));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_invoices_list: { disabled: true } },
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toMatch(/zero live host tools/i);
  });

  it("grades the live-surface check through a judgments.json disable — the layer runtime applies", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    await writeFile(join(root, ".vendo", "judgments.json"), JSON.stringify({
      format: "vendo/judgments@1",
      tools: {
        host_invoices_list: {
          binding: "GET /api/invoices",
          fields: { disabled: true },
          evidence: "the handler requires an admin session",
        },
      },
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toMatch(/zero live host tools/i);
  });

  it("a human overrides.json wake beats a judgments.json disable in the live-surface count", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    await writeFile(join(root, ".vendo", "judgments.json"), JSON.stringify({
      format: "vendo/judgments@1",
      tools: {
        host_invoices_list: {
          binding: "GET /api/invoices",
          fields: { disabled: true },
          evidence: "the handler requires an admin session",
        },
      },
    }));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_invoices_list: { disabled: false } },
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
  });

  it("ignores a judgments.json entry whose binding moved (an inert judgment never disables)", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    await writeFile(join(root, ".vendo", "judgments.json"), JSON.stringify({
      format: "vendo/judgments@1",
      tools: {
        host_invoices_list: {
          binding: "GET /api/old-invoices",
          fields: { disabled: true },
          evidence: "stale — the handler moved",
        },
      },
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
  });

  it("checks wiring and performs one live status round-trip", async () => {
    const fetchImpl = successfulProbeFetch();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl,
      output: { log() {}, error() {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/vendo/status");
    // The render gate rides the same live pass: one GET of the app origin.
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://localhost:3000/");
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("http://localhost:3000/api/vendo/doctor/present");
    expect(fetchImpl.mock.calls[3]?.[0]).toBe("http://localhost:3000/api/vendo/doctor/act-as");
    expect(fetchImpl.mock.calls[4]?.[0]).toBe("http://localhost:3000/api/vendo/doctor/machines");
  });

  // execution-v2 Lane D — machine/schedule reporting (dev-only wire surface).
  it("reports machine-bearing apps and warns when schedules have no caller", async () => {
    const fetchImpl = successfulProbeFetch();
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/status")) {
        return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      }
      if (url.endsWith("/doctor/present") || url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
      if (url.endsWith("/doctor/machines")) {
        return Response.json({
          scheduleCallerConfigured: false,
          machines: [{
            appId: "app_cron",
            name: "Cron app",
            awake: false,
            schedules: [{ cron: "0 8 * * *", fn: "chase" }],
          }],
        });
      }
      return Response.json({ error: { message: "unexpected probe" } }, { status: 404 });
    });
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0); // reporting only — a missing caller warns, never fails
    expect(messages.logs).toContain("ok: 1 machine-bearing app");
    expect(messages.logs.join("\n")).toContain("0 8 * * * -> POST /fn/chase");
    expect(messages.errors.join("\n")).toContain("set VENDO_TICK_SECRET");
  });

  it("passes the schedule-caller check when the tick secret is configured", async () => {
    const fetchImpl = successfulProbeFetch();
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/status")) {
        return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      }
      if (url.endsWith("/doctor/present") || url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
      if (url.endsWith("/doctor/machines")) {
        return Response.json({ scheduleCallerConfigured: true, machines: [{ appId: "app_cron", name: "Cron app", awake: true, schedules: [] }] });
      }
      return Response.json({ error: { message: "unexpected probe" } }, { status: 404 });
    });
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
    expect(messages.logs.join("\n")).toContain("schedule caller configured");
  });

  it.each(["cloud", "custom"] as const)("reports a lit %s execution venue", async (sandbox) => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch({ store: true, sandbox }),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toContain(`ok: execution venue: ${sandbox}`);
  });

  // 0.4.4 defect C — an e2b venue is blessed only when it is USABLE: key set
  // and SDK resolvable from the project. "ok: execution venue: e2b" on a
  // keyless host certified a composition whose every server-app build died
  // (the venue ladder had picked e2b over the Cloud sandbox).
  it("reports a lit e2b execution venue when the key is set and the SDK resolves", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch({ store: true, sandbox: "e2b" }),
      env: { E2B_API_KEY: "e2b_key" },
      e2bResolvable: () => true,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toContain("ok: execution venue: e2b");
  });

  it("fails when the wire selected e2b but no E2B_API_KEY is set", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch({ store: true, sandbox: "e2b" }),
      env: {},
      e2bResolvable: () => true,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toContain(
      "broken: the running wire selected the e2b execution venue but E2B_API_KEY is not set; server-app builds will fail in an unusable sandbox. Fix: install the e2b package and set E2B_API_KEY, or remove E2B_API_KEY from the server env (with VENDO_API_KEY set, the managed Cloud sandbox takes over), then restart the dev server and re-run doctor",
    );
  });

  it("fails when the wire selected e2b but the SDK does not resolve from the project", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch({ store: true, sandbox: "e2b" }),
      env: { E2B_API_KEY: "e2b_key" },
      e2bResolvable: () => false,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toContain(
      "broken: the running wire selected the e2b execution venue but the e2b package does not resolve from this project; server-app builds will fail in an unusable sandbox. Fix: install the e2b package and set E2B_API_KEY, or remove E2B_API_KEY from the server env (with VENDO_API_KEY set, the managed Cloud sandbox takes over), then restart the dev server and re-run doctor",
    );
  });

  it("warns with actionable guidance when the execution venue is dark", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch({ store: true, sandbox: false }),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toContain(
      "warning: install the e2b package and set E2B_API_KEY, or set VENDO_API_KEY for the managed Cloud sandbox, or pass sandbox: to createVendo; without one, server apps (rungs 2-4) return sandbox-unavailable",
    );
    expect(messages.logs).toContain(
      "Ladder: execution venue is checked above; actAs for away host actions; connectors for external tools.",
    );
  });

  it("warns instead of failing when an older host omits the execution venue", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch({ store: true }),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toContain(
      "warning: host /status does not report an execution venue; upgrade @vendoai/vendo to enable the venue check",
    );
  });

  it("fails when /status reports an unknown execution venue", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch({ store: true, sandbox: "mainframe" }),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toContain("broken: /status returned an invalid execution venue");
  });

  it("returns one for broken wiring or an unreachable live handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-broken-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const messages = output();
    expect(await doctor({ targetDir: root, fetchImpl, output: messages.sink })).toBe(1);
    expect(messages.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("start the dev server"),
      expect.stringContaining("cannot probe actAs"),
    ]));
  });

  it("proves present credentials and actAs mint+verify over a real booted server", async () => {
    const host = await liveHost();
    const messages = output();
    expect(await doctor({
      targetDir: host.root,
      url: host.url,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toEqual(expect.arrayContaining([
      "ok: present credentials reach the host API",
      "ok: actAs mint + host verification live round-trip",
    ]));
    expect(host.actAs).toHaveBeenCalledOnce();
    const [syntheticPrincipal, syntheticGrant] = host.actAs.mock.calls[0] as [Principal, PermissionGrant];
    expect(syntheticPrincipal.subject).toContain("vendo_doctor");
    expect(syntheticGrant).toMatchObject({
      subject: syntheticPrincipal.subject,
      source: "automation",
      scope: { kind: "tool" },
    });
  });

  it("fails actionably when VENDO_BASE_URL leaves present credentials disabled", async () => {
    const host = await liveHost({ configureBaseUrl: false });
    const messages = output();
    expect(await doctor({
      targetDir: host.root,
      url: host.url,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toContain(
      "broken: present credentials did not reach the host API; set VENDO_BASE_URL to the running host origin and restart the dev server",
    );
  });

  it("warns actionably when actAs is not configured without breaking present-only hosts", async () => {
    const host = await liveHost({ actAs: false });
    const messages = output();
    expect(await doctor({
      targetDir: host.root,
      url: host.url,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toContain(
      "warning: actAs is not configured; pass createVendo({ actAs }) before enabling away host actions",
    );
  });

  it("validates server.json and its remote against the live MCP door", async () => {
    const root = await healthy();
    await writeFile(join(root, "server.json"), JSON.stringify({
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "com.example/maple",
      description: "Maple banking tools",
      version: "1.2.3",
      remotes: [{ type: "streamable-http", url: "https://mcp.example.com/api/vendo/mcp" }],
    }));
    const messages = output();

    expect(await doctor({
      targetDir: root,
      url: "https://mcp.example.com/api/vendo",
      fetchImpl: discoveryFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toContain("ok: server.json matches MCP registry discovery requirements");
    expect(messages.logs).toContain("ok: server.json remote agrees with the live MCP door");
  });

  it("reports invalid registry structure and a remote mounted at the wrong URL", async () => {
    const root = await healthy();
    await writeFile(join(root, "server.json"), JSON.stringify({
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "com.example/maple",
      description: "x".repeat(101),
      version: "1.2.3",
      remotes: [{ type: "streamable-http", url: "https://mcp.example.com/wrong" }],
    }));
    const messages = output();

    expect(await doctor({
      targetDir: root,
      url: "https://mcp.example.com/api/vendo",
      fetchImpl: discoveryFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toContain("server.json is invalid");
    expect(messages.errors).toContain("broken: server.json remote does not match the live MCP door https://mcp.example.com/api/vendo/mcp");
  });

  it("validates a registry auth challenge when the live host serves one", async () => {
    const root = await healthy();
    const messages = output();

    expect(await doctor({
      targetDir: root,
      url: "https://mcp.example.com/api/vendo",
      fetchImpl: discoveryFetch("not-an-mcp-challenge"),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toContain("broken: MCP registry auth challenge must start with v=MCPv1");
  });
});

/** Probe fetch that also answers the live-turn POST /threads with a UI-message
 *  SSE stream. `reply` "" simulates a turn that produces no text. */
function probeFetchWithTurn(reply = "I can respond.", options: { errorFrame?: boolean } = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/status")) return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
    if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
    if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
    if (url.endsWith("/threads") && init?.method === "POST") {
      const frames: string[] = [];
      if (options.errorFrame) frames.push('data: {"type":"error"}\n\n');
      else if (reply.length > 0) frames.push(`data: ${JSON.stringify({ type: "text-delta", delta: reply })}\n\n`);
      frames.push("data: [DONE]\n\n");
      return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ error: { message: "unexpected probe" } }, { status: 404 });
  });
}

describe("vendo doctor v2 (live turn + --json + cloud + dev-server probe)", () => {
  it("states the winning model credential rung and any active VENDO_MODEL_* pins — nothing more", async () => {
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl: probeFetchWithTurn(),
      env: {
        ANTHROPIC_API_KEY: "sk-test",
        VENDO_MODEL: "claude-opus-4-8",
        VENDO_MODEL_PAINT: "claude-haiku-4-5",
      },
      interactive: false,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      npmLatest: async () => null,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toContain("ok: model credential: explicit ANTHROPIC_API_KEY (anthropic)");
    expect(messages.logs).toContain("ok: model pins: VENDO_MODEL=claude-opus-4-8, VENDO_MODEL_PAINT=claude-haiku-4-5");

    // No pins → no pins line (and never a role/alias table: the client cannot
    // know the gateway's server-side alias mappings).
    const bare = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl: probeFetchWithTurn(),
      env: { ANTHROPIC_API_KEY: "sk-test" },
      interactive: false,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      npmLatest: async () => null,
      output: bare.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(bare.logs.some((line) => line.includes("model pins:"))).toBe(false);
    expect(bare.logs).toContain("ok: model credential: explicit ANTHROPIC_API_KEY (anthropic)");
  });

  it("runs one real model turn over the wired route and exits 0 when it answers", async () => {
    const fetchImpl = probeFetchWithTurn("Yes, I can respond.");
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      interactive: false,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      npmLatest: async () => null,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(fetchImpl.mock.calls.some(([u]) => String(u).endsWith("/threads"))).toBe(true);
    expect(messages.logs.some((line) => line.startsWith("ok: live model turn answered"))).toBe(true);
    expect(messages.logs.join("\n")).toContain("Yes, I can respond.");
  });

  it("exits nonzero when the live turn produces no answer", async () => {
    const fetchImpl = probeFetchWithTurn("", { errorFrame: true });
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      interactive: false,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      npmLatest: async () => null,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.some((line) => line.startsWith("broken: live model turn did not answer"))).toBe(true);
  });

  it("emits one machine-readable JSON object a script can consume", async () => {
    const logs: string[] = [];
    const exit = await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
      json: true,
      output: { log: (m) => logs.push(m), error: () => {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    // --json prints exactly one object to stdout and nothing else.
    expect(logs).toHaveLength(1);
    const report = JSON.parse(logs[0]!) as {
      vendo: string; wired: boolean; exit: number;
      checks: Array<{ status: string; message: string }>;
      liveTurn: { ok: boolean }; cloud: { present: boolean };
      summary: { failures: number; warnings: number };
    };
    expect(report.vendo).toBe("doctor");
    expect(report.exit).toBe(exit);
    expect(report.wired).toBe(true);
    expect(report.liveTurn.ok).toBe(true);
    expect(report.cloud.present).toBe(false);
    expect(report.checks.some((c) => c.status === "ok")).toBe(true);
    expect(report.summary.failures).toBe(0);
  });

  it("reports exit 1 in --json when wiring is broken", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-json-broken-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const logs: string[] = [];
    const exit = await doctor({
      targetDir: root,
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
      json: true,
      liveTurn: undefined, // exercise the real skip path (server unreachable)
      output: { log: (m) => logs.push(m), error: () => {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    const report = JSON.parse(logs[0]!) as { exit: number; wired: boolean; liveTurn: { attempted: boolean } };
    expect(exit).toBe(1);
    expect(report.exit).toBe(1);
    expect(report.wired).toBe(false);
    expect(report.liveTurn.attempted).toBe(false);
  });

  it("reports a present, well-formed VENDO_API_KEY", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
      cloudProbe: async () => ({ present: true, ok: true, unlocks: ["x"] }),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toContain("ok: Vendo Cloud key present and well-formed");
  });

  it("warns when VENDO_API_KEY is present but invalid", async () => {
    const messages = output();
    await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
      cloudProbe: async () => ({ present: true, ok: false, unlocks: ["x"], error: "revoked" }),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(messages.errors).toContain("warning: VENDO_API_KEY is set but not usable: revoked");
  });

  it("prints what Cloud unlocks when no key is set", async () => {
    const messages = output();
    await doctor({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["a starter allowance", "team sharing"] }),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(messages.logs.some((l) => l.includes("A key unlocks a starter allowance; team sharing"))).toBe(true);
  });

  it("offers (consent) to start the dev server when nothing is listening", async () => {
    let serverUp = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/status")) {
        if (!serverUp) throw new Error("connection refused");
        return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      }
      if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
      if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
      if (url.endsWith("/threads") && init?.method === "POST") {
        return new Response('data: {"type":"text-delta","delta":"hi"}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: { message: "unexpected" } }, { status: 404 });
    });
    const stop = vi.fn();
    const startDevServer = vi.fn(async () => { serverUp = true; return { ok: true, stop }; });
    const confirm = vi.fn(async () => true);
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      interactive: true,
      confirm,
      startDevServer,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      npmLatest: async () => null,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(startDevServer).toHaveBeenCalledOnce();
    expect(messages.logs).toContain("ok: started the dev server for the probe");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("--yes auto-starts the dev server without a prompt in non-interactive runs", async () => {
    // The flag's documented purpose (quickstart: "pass --yes to start it
    // non-interactively") — agents and CI run with piped stdio, so the
    // auto-start must not require a TTY.
    let serverUp = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/status")) {
        if (!serverUp) throw new Error("connection refused");
        return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      }
      if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
      if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
      if (url.endsWith("/threads") && init?.method === "POST") {
        return new Response('data: {"type":"text-delta","delta":"hi"}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: { message: "unexpected" } }, { status: 404 });
    });
    const stop = vi.fn();
    const startDevServer = vi.fn(async () => { serverUp = true; return { ok: true, stop }; });
    const confirm = vi.fn(async () => { throw new Error("--yes must not prompt"); });
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      interactive: false,
      yes: true,
      confirm,
      startDevServer,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      npmLatest: async () => null,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(startDevServer).toHaveBeenCalledOnce();
    expect(messages.logs).toContain("ok: started the dev server for the probe");
    expect(stop).toHaveBeenCalledOnce();
  });

  // §4 customization ladder — ejected chrome is the host's code; doctor only
  // raises awareness when it predates the installed @vendoai/ui. Warn, never fail.
  it("warns — never fails — when an ejected surface predates the installed @vendoai/ui", async () => {
    const root = await healthy();
    await mkdir(join(root, "components", "vendo", "thread"), { recursive: true });
    await writeFile(
      join(root, "components", "vendo", "thread", ".vendo-eject.json"),
      JSON.stringify({ surface: "thread", package: "@vendoai/ui", version: "0.2.0" }),
    );
    await mkdir(join(root, "node_modules", "@vendoai", "ui"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "@vendoai", "ui", "package.json"),
      JSON.stringify({ name: "@vendoai/ui", version: "0.3.0" }),
    );
    const messages = output();
    const code = await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(code).toBe(0);
    const warning = messages.errors.find((line) => line.includes("ejected thread"));
    expect(warning).toBeDefined();
    expect(warning).toContain("v0.2.0");
    expect(warning).toContain("v0.3.0");
    expect(warning).toContain("changelog");
    expect(warning).toContain("warning");
  });

  it("skips the drift check quietly when the installed @vendoai/ui package.json is malformed", async () => {
    const root = await healthy();
    await mkdir(join(root, "components", "vendo", "thread"), { recursive: true });
    await writeFile(
      join(root, "components", "vendo", "thread", ".vendo-eject.json"),
      JSON.stringify({ surface: "thread", package: "@vendoai/ui", version: "0.2.0" }),
    );
    await mkdir(join(root, "node_modules", "@vendoai", "ui"), { recursive: true });
    await writeFile(join(root, "node_modules", "@vendoai", "ui", "package.json"), "{not json");
    const messages = output();
    const code = await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(code).toBe(0);
    expect([...messages.logs, ...messages.errors].some((line) => line.includes("ejected"))).toBe(false);
  });

  it("passes the drift check when the ejected surface matches the installed @vendoai/ui", async () => {
    const root = await healthy();
    await mkdir(join(root, "src", "components", "vendo", "thread"), { recursive: true });
    await writeFile(
      join(root, "src", "components", "vendo", "thread", ".vendo-eject.json"),
      JSON.stringify({ surface: "thread", package: "@vendoai/ui", version: "0.3.0" }),
    );
    await mkdir(join(root, "node_modules", "@vendoai", "ui"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "@vendoai", "ui", "package.json"),
      JSON.stringify({ name: "@vendoai/ui", version: "0.3.0" }),
    );
    const messages = output();
    await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(messages.logs.some((line) => line.includes("ejected thread matches @vendoai/ui v0.3.0"))).toBe(true);
    expect(messages.errors.some((line) => line.includes("ejected"))).toBe(false);
  });
});

/** Agent-install DX (design 2026-07-19 §CLI-3) — every check carries a stable
 *  id; failures and warnings additionally carry a registry `error_code` and a
 *  full `fix_ref` URL into vendo.run/agents/verify. Passing checks carry
 *  neither (nothing to fix). */
describe("vendo doctor error codes + fix_refs", () => {
  interface CodedCheck {
    id: string;
    status: string;
    message: string;
    error_code?: string;
    fix_ref?: string;
  }

  async function jsonChecks(options: Parameters<typeof runDoctor>[0]): Promise<{ exit: number; report: { exit: number; wired: boolean; checks: CodedCheck[] } }> {
    const logs: string[] = [];
    const exit = await doctor({
      json: true,
      output: { log: (m) => logs.push(m), error: () => {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      ...options,
    });
    return { exit, report: JSON.parse(logs[0]!) as { exit: number; wired: boolean; checks: CodedCheck[] } };
  }

  it("stamps every failing check with a registered error_code and a full fix_ref URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-codes-broken-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
      liveTurn: undefined, // exercise the real skip path (server unreachable)
    });
    expect(exit).toBe(1);
    expect(report.exit).toBe(1);
    const failures = report.checks.filter((check) => check.status !== "ok");
    expect(failures.length).toBeGreaterThan(0);
    for (const check of failures) {
      expect(check.id).toBeTruthy();
      expect(check.error_code).toMatch(/^E-[A-Z]+-\d{3}$/);
      expect(doctorErrorCodes).toContain(check.error_code);
      expect(check.fix_ref).toBe(`https://vendo.run/agents/verify?v=${CLI_VERSION}#${check.error_code}`);
    }
    // The remediation surface is broad: wiring, config, live probes, auth, turn.
    const codes = new Set(failures.map((check) => check.error_code));
    expect(codes.size).toBeGreaterThan(4);
  });

  it("keeps passing checks lean: id always, no error_code or fix_ref", async () => {
    const { exit, report } = await jsonChecks({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(0);
    expect(report.wired).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const check of report.checks) {
      expect(check.status).toBe("ok");
      expect(check.id).toBeTruthy();
      expect(check).not.toHaveProperty("error_code");
      expect(check).not.toHaveProperty("fix_ref");
    }
  });

  /** A composition that never declared itself development does not mount the
      doctor probes at all (that is the fix in #989), so both auth probes come
      back 404. Doctor used to read that 404 as a credential failure and told
      the reader to set VENDO_BASE_URL or to go check createVendo({ actAs }) —
      both false, and both send them to fix something that is not broken. What
      makes the undeclared composition IDENTIFIABLE is /doctor/base-url still
      answering: every composition mounts it, only a development one mounts the
      probes beside it. */
  it("blames the unmounted probe surface, not VENDO_BASE_URL or actAs, when the composition never declared development", async () => {
    const unmountedProbes = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/status")) {
        return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      }
      // Mounted in every environment, development or not — so the wire IS here.
      if (url.endsWith("/doctor/base-url")) return Response.json({ ok: true });
      // What the real wire answers for a route that is not in the table.
      return Response.json({ error: { code: "not-found", message: "unknown Vendo route" } }, { status: 404 });
    });
    const { report } = await jsonChecks({ targetDir: await healthy(), fetchImpl: unmountedProbes });

    const present = report.checks.find((check) => check.id === "auth/present");
    expect(present?.status).toBe("broken");
    expect(present?.message).toContain("development");
    expect(present?.message).not.toContain("VENDO_BASE_URL");

    const actAs = report.checks.find((check) => check.id === "auth/act-as");
    expect(actAs?.status).toBe("broken");
    expect(actAs?.message).toContain("development");
    expect(actAs?.message).not.toContain("verifier middleware");
  });

  /** The mirror image, and the reason the message above may not be asserted
      from a bare 404: a base URL with the wrong origin or path prefix — behind
      a proxy whose route rule matched /status but not /doctor/* — serves a
      valid /status while every doctor path 404s. Telling that reader to pass
      development: true is the same wrong-advice bug pointed the other way. The
      tell is /doctor/base-url not answering like a wire: no composition leaves
      that route out, so the wire is not at this URL and the development gate
      is not the story. */
  it("does not blame the development gate when /doctor/base-url 404s alongside the probes", async () => {
    const wrongBase = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/status")) {
        return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      }
      return Response.json({ error: { code: "not-found", message: "no route" } }, { status: 404 });
    });
    const { report } = await jsonChecks({ targetDir: await healthy(), fetchImpl: wrongBase });

    for (const id of ["auth/present", "auth/act-as"]) {
      const check = report.checks.find((entry) => entry.id === id);
      expect(check?.status).toBe("broken");
      expect(check?.message).toContain("/doctor/base-url");
      // The undeclared-composition advice is the one thing it must NOT say.
      expect(check?.message).not.toContain("development: true");
      expect(check?.message).not.toContain("NODE_ENV=development");
    }
  });

  /** Reading "not a 404" as "the wire is here" is the same mistake a third
      time. An HTML catch-all, an auth layer or a proxy error page answers 200,
      401, 302 or 500 at any path on the origin without a Vendo route table
      behind it — so the wrong-wire-base diagnosis has to survive those, not
      just a clean 404. Only a Vendo-SHAPED body ({ ok }, which the route
      answers in every environment) is evidence the wire is there at all. */
  it.each([
    ["an HTML catch-all", new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["an auth layer", new Response("<html>sign in</html>", { status: 401, headers: { "content-type": "text/html" } })],
    ["a proxy error page", new Response("<html>bad gateway</html>", { status: 500, headers: { "content-type": "text/html" } })],
  ])("keeps the wrong-wire-base diagnosis when /doctor/base-url is answered by %s", async (_label, answer) => {
    const intermediary = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/status")) {
        return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      }
      if (url.endsWith("/doctor/base-url")) return answer.clone();
      return Response.json({ error: { code: "not-found", message: "no route" } }, { status: 404 });
    });
    const { report } = await jsonChecks({ targetDir: await healthy(), fetchImpl: intermediary });

    for (const id of ["auth/present", "auth/act-as"]) {
      const check = report.checks.find((entry) => entry.id === id);
      expect(check?.status).toBe("broken");
      expect(check?.message).not.toContain("development: true");
      expect(check?.message).not.toContain("NODE_ENV=development");
    }
  });

  /** Neither message may ASSERT a cause, because no observable response
      separates them: a real Vendo deployment that is simply not the one you
      meant — a stale base URL pointing at staging — answers /status and
      /doctor/base-url perfectly and 404s the development-only probes, byte for
      byte identical to your own dev server with the gate closed. Doctor cannot
      know which deployment the reader meant, so it reports what it saw and
      tells them how to separate the two themselves. */
  it("names both causes and how to separate them rather than asserting one", async () => {
    const wireAnswers = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/status")) {
        return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      }
      if (url.endsWith("/doctor/base-url")) return Response.json({ ok: true });
      return Response.json({ error: { code: "not-found", message: "unknown Vendo route" } }, { status: 404 });
    });
    const { report } = await jsonChecks({ targetDir: await healthy(), fetchImpl: wireAnswers });

    const message = report.checks.find((check) => check.id === "auth/present")?.message ?? "";
    // Both candidate causes, and the step that tells them apart.
    expect(message).toContain("development: true");
    expect(message).toContain("not the dev server you meant");
    expect(message).toContain("re-run");
    // No bare assertion that the composition is the undeclared one.
    expect(message).not.toContain("this composition did not declare itself development");
  });

  it("stamps warnings with codes too without flipping the exit", async () => {
    const { exit, report } = await jsonChecks({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
      cloudProbe: async () => ({ present: true, ok: false, unlocks: ["x"], error: "revoked" }),
    });
    expect(exit).toBe(0);
    const warning = report.checks.find((check) => check.status === "warning");
    expect(warning).toMatchObject({
      id: "cloud/key",
      error_code: "E-CLOUD-001",
      fix_ref: doctorFixRef("E-CLOUD-001"),
    });
  });

  it("warns E-TOOLS-004 for blind schema slots and passes when both are covered", async () => {
    const tool = (markers: Record<string, string>) => ({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object", properties: {} }, risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
        ...markers,
      }],
    });

    const blindRoot = await healthy();
    await writeFile(join(blindRoot, ".vendo", "tools.json"),
      JSON.stringify(tool({ inputSchemaSource: "declared", outputSchemaSource: "unknown" })));
    const blind = await jsonChecks({ targetDir: blindRoot, fetchImpl: successfulProbeFetch() });
    const warning = blind.report.checks.find((check) => check.id === "tools/schemas");
    expect(warning).toMatchObject({ status: "warning", error_code: "E-TOOLS-004" });
    expect(warning?.message).toContain("inputs 1/1 · outputs 0/1");
    expect(warning?.message).toContain("host_invoices_list");

    const coveredRoot = await healthy();
    await writeFile(join(coveredRoot, ".vendo", "tools.json"),
      JSON.stringify(tool({ inputSchemaSource: "declared", outputSchemaSource: "declared" })));
    const covered = await jsonChecks({ targetDir: coveredRoot, fetchImpl: successfulProbeFetch() });
    expect(covered.report.checks.find((check) => check.error_code === "E-TOOLS-004")).toBeUndefined();
    expect(covered.report.checks.find((check) => check.id === "tools/schemas"))
      .toMatchObject({ status: "ok", message: "catalog: inputs 1/1 · outputs 1/1" });
  });

  it("check ids are unique across a full run, healthy and broken alike", async () => {
    // Duplicate ids would make fix_ref anchors and agents' remediation notes
    // ambiguous — every check in one run must be individually addressable.
    const healthyRun = await jsonChecks({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
    });
    const brokenRoot = await mkdtemp(join(tmpdir(), "vendo-doctor-ids-broken-"));
    cleanup.push(() => rm(brokenRoot, { recursive: true, force: true }));
    const brokenRun = await jsonChecks({
      targetDir: brokenRoot,
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
      liveTurn: undefined, // exercise the real skip path (server unreachable)
    });
    for (const { report } of [healthyRun, brokenRun]) {
      const ids = report.checks.map((check) => check.id);
      expect(ids.length).toBeGreaterThan(0);
      expect([...new Set(ids)].sort()).toEqual([...ids].sort());
    }
  });

  it("reports per-surface ownership with the overrides enablement note (#557 landed)", async () => {
    const { report } = await jsonChecks({ targetDir: await healthy(), fetchImpl: successfulProbeFetch() });
    const ownership = report.checks.find((check) => check.id === "config/ownership");
    expect(ownership).toBeDefined();
    expect(ownership!.message.toLowerCase()).toContain("enablement");
    expect(ownership!.message).toContain("boot-once");
  });

  // #478 short-term — npm installs the ai@7 peer conflict without failing, the
  // static checks all pass, and then every internal turn throws
  // AI_InvalidPromptError (v7 removed system-role messages). Doctor reads the
  // HOST's installed `ai` and fails fast on an unsupported major.
  it("fails fast with E-DEP-001 when the host has ai@7 installed", async () => {
    const root = await healthy();
    await mkdir(join(root, "node_modules", "ai"), { recursive: true });
    await writeFile(join(root, "node_modules", "ai", "package.json"), JSON.stringify({ name: "ai", version: "7.0.2" }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "deps/ai-sdk-major");
    expect(check).toMatchObject({
      status: "broken",
      error_code: "E-DEP-001",
      fix_ref: doctorFixRef("E-DEP-001"),
    });
    expect(check?.message).toContain("ai@7.0.2");
    expect(check?.message).toContain("ai@6");
    expect(check?.message).toContain("npm install ai@^6 @ai-sdk/anthropic@^3 @ai-sdk/react@^3");
    expect(check?.message).toContain("github.com/runvendo/vendo/issues/478");
  });

  it("passes the ai major check on an ai@6 host", async () => {
    const root = await healthy();
    await mkdir(join(root, "node_modules", "ai"), { recursive: true });
    await writeFile(join(root, "node_modules", "ai", "package.json"), JSON.stringify({ name: "ai", version: "6.0.28" }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(0);
    const check = report.checks.find((entry) => entry.id === "deps/ai-sdk-major");
    expect(check).toMatchObject({ status: "ok" });
    expect(check?.message).toContain("ai@6.0.28");
  });

  it("skips the ai major check silently when ai is not installed", async () => {
    // The missing-dependency story belongs to the wiring checks and the live
    // turn — an absent node_modules/ai must not break (or even mention) this.
    const { exit, report } = await jsonChecks({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(0);
    expect(report.checks.some((entry) => entry.id === "deps/ai-sdk-major")).toBe(false);
  });

  it("fails with E-DEP-003 when the installed zod predates the AI SDK's subpaths", async () => {
    // FINDINGS F2 (skateshop): ai@6 imports zod/v3 + zod/v4, which arrive in
    // zod 3.25 — a host pinning older zod builds red the moment the vendo
    // wiring pulls ai into the bundle.
    const root = await healthy();
    await mkdir(join(root, "node_modules", "zod"), { recursive: true });
    await writeFile(join(root, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version: "3.23.8" }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "deps/zod-floor");
    expect(check).toMatchObject({
      status: "broken",
      error_code: "E-DEP-003",
      fix_ref: doctorFixRef("E-DEP-003"),
    });
    expect(check?.message).toContain("zod@3.23.8");
    expect(check?.message).toContain("3.25");
    expect(check?.message).toContain("npm install zod@^3.25.0");
  });

  it("passes the zod floor check on a 3.25+ or zod 4 host", async () => {
    for (const version of ["3.25.76", "4.1.8"]) {
      const root = await healthy();
      await mkdir(join(root, "node_modules", "zod"), { recursive: true });
      await writeFile(join(root, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version }));
      const { exit, report } = await jsonChecks({
        targetDir: root,
        fetchImpl: successfulProbeFetch(),
      });
      expect(exit).toBe(0);
      const check = report.checks.find((entry) => entry.id === "deps/zod-floor");
      expect(check).toMatchObject({ status: "ok" });
      expect(check?.message).toContain(`zod@${version}`);
    }
  });

  it("fails E-DEP-003 when the workspace root hoists an old zod above the app", async () => {
    // Hoisted pnpm/yarn workspaces keep zod at the workspace root and the app
    // nested with no node_modules of its own — the version must be resolved
    // the way the host runtime resolves it, and the bump command must match
    // the workspace's package manager.
    const workspace = await mkdtemp(join(tmpdir(), "vendo-doctor-workspace-"));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");
    await mkdir(join(workspace, "node_modules", "zod"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version: "3.23.8" }));
    const root = await healthy(join(workspace, "apps", "web"));
    const { exit, report } = await jsonChecks({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "deps/zod-floor");
    expect(check).toMatchObject({
      status: "broken",
      error_code: "E-DEP-003",
      fix_ref: doctorFixRef("E-DEP-003"),
    });
    expect(check?.message).toContain("zod@3.23.8");
    expect(check?.message).toContain("pnpm add zod@^3.25.0");
  });

  it("skips the zod floor check silently when zod is not installed", async () => {
    // A host without its own zod resolves ai's copy, which always satisfies.
    const { exit, report } = await jsonChecks({
      targetDir: await healthy(),
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(0);
    expect(report.checks.some((entry) => entry.id === "deps/zod-floor")).toBe(false);
  });

  it("exits nonzero while any single check fails", async () => {
    const root = await healthy();
    await rm(join(root, ".vendo", "brief.md"));
    const { exit, report } = await jsonChecks({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(1);
    expect(report.wired).toBe(false);
    const broken = report.checks.filter((check) => check.status === "broken");
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      id: "config/brief.md",
      error_code: "E-CFG-001",
      fix_ref: doctorFixRef("E-CFG-001"),
    });
  });

  /** Spec 2026-08-06 §B1: the path prefix has ONE home, VENDO_BASE_URL. A spec
   *  declaring a different relative server mount is #914 by another route —
   *  every page renders and every host tool 404s. */
  const specWithMount = JSON.stringify({
    openapi: "3.1.0", info: { title: "t", version: "1" }, servers: [{ url: "/maple" }], paths: {},
  });

  it("fails E-CFG-003 when the OpenAPI server mount and VENDO_BASE_URL's path disagree", async () => {
    const root = await healthy();
    await writeFile(join(root, "openapi.json"), specWithMount, "utf8");
    const { report } = await jsonChecks({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      env: { VENDO_BASE_URL: "https://site.com" },
    });
    expect(report.checks.find((check) => check.id === "config/mount")).toMatchObject({
      status: "broken",
      error_code: "E-CFG-003",
    });
  });

  it("passes config/mount when the spec and VENDO_BASE_URL agree", async () => {
    const root = await healthy();
    await writeFile(join(root, "openapi.json"), specWithMount, "utf8");
    const { report } = await jsonChecks({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      env: { VENDO_BASE_URL: "https://site.com/maple" },
    });
    expect(report.checks.find((check) => check.id === "config/mount")).toMatchObject({ status: "ok" });
  });

  // Visible-surface gate (0.4.1 E2E cert B3): green must mean a user can SEE
  // the agent — <VendoProvider> alone is a provider that renders nothing.
  it("fails E-WIRE-006 when nothing visible is mounted, and exits 1", async () => {
    const root = await healthy();
    await writeFile(join(root, "app", "layout.tsx"),
      "export default ({children}) => <VendoProvider>{children}</VendoProvider>;");
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    const errors = messages.errors.join("\n");
    expect(errors).toContain("no visible agent surface is mounted");
    expect(errors).toContain("<VendoOverlay />");
  });

  // Server actions fail closed and nothing else goes red (ENG-248): init only
  // ever CREATES, so a route or a map that predates the host's "use server"
  // surface stays as the developer left it, and doctor is where that surfaces.
  it("fails E-WIRE-009 when detected server actions are neither registered nor wired", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nconst vendo = createVendo({});\nexport const { GET } = vendo;\n');
    const { exit, report } = await jsonChecks({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "wiring/server-actions");
    expect(check).toMatchObject({ status: "broken", error_code: "E-WIRE-009" });
    expect(check?.message).toContain("vendo-actions.ts is missing");
    expect(check?.message).toContain("does not pass serverActions");
  });

  it("passes wiring/server-actions once the map registers the action and the route passes it", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo-actions.ts"),
      'export const serverActions = {\n  "app/actions/later.ts#later": async () => 1,\n};\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nimport { serverActions } from "./vendo-actions";\nconst vendo = createVendo({ serverActions });\nexport const { GET } = vendo;\n');
    const { report } = await jsonChecks({ targetDir: root, fetchImpl: successfulProbeFetch() });
    expect(report.checks.find((entry) => entry.id === "wiring/server-actions")).toMatchObject({ status: "ok" });
  });

  it("says nothing about server actions in a host that has none", async () => {
    const { report } = await jsonChecks({ targetDir: await healthy(), fetchImpl: successfulProbeFetch() });
    expect(report.checks.some((entry) => entry.id === "wiring/server-actions")).toBe(false);
  });

  // Regression (review B1): the import line is NOT wiring — the call is. This
  // is where a half-applied paste lands, so a check that greps the whole file
  // goes green on precisely the state it exists to catch. Init and doctor read
  // it through the same helper so they cannot disagree.
  it("fails E-WIRE-009 when the route imports the map but never passes it to createVendo", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo-actions.ts"),
      'export const serverActions = {\n  "app/actions/later.ts#later": async () => 1,\n};\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nimport { serverActions } from "./vendo-actions";\nconst vendo = createVendo({});\nexport const { GET } = vendo;\n');
    const { exit, report } = await jsonChecks({ targetDir: root, fetchImpl: successfulProbeFetch() });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "wiring/server-actions");
    expect(check).toMatchObject({ status: "broken", error_code: "E-WIRE-009" });
    expect(check?.message).toContain("does not pass serverActions inside createVendo");
    // The map itself is complete — do not accuse it.
    expect(check?.message).not.toContain("does not register");
  });

  // Regression (review 3): a route that composes its own map is a shape init
  // deliberately leaves alone ("leaves a hand-customized route ... untouched"),
  // so doctor must not report the generated map it never wanted as missing.
  it("stays silent when the route passes a map it composes itself", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nconst serverActions = { later: async () => 1 };\nconst vendo = createVendo({ serverActions });\nexport const { GET } = vendo;\n');
    const { report } = await jsonChecks({ targetDir: root, fetchImpl: successfulProbeFetch() });
    expect(report.checks.some((entry) => entry.id === "wiring/server-actions")).toBe(false);
  });

  // Regression (review 4): a tool a human disabled is one the runtime never
  // dispatches — hard-failing on its registration demands work that buys
  // nothing. The rest of doctor honors overrides; this check does too.
  it("stays silent about an action disabled in .vendo/overrides.json", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    // Nothing registered, nothing wired — the state that fails without overrides.
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nconst vendo = createVendo({});\nexport const { GET } = vendo;\n');
    const broken = await jsonChecks({ targetDir: root, fetchImpl: successfulProbeFetch() });
    expect(broken.report.checks.find((entry) => entry.id === "wiring/server-actions")?.status).toBe("broken");

    const { tools } = await extractServerActions(root);
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@3",
      tools: Object.fromEntries(tools.map((tool) => [tool.name, { disabled: true }])),
      remix: { ignoreSlots: [] },
    }));
    const { report } = await jsonChecks({ targetDir: root, fetchImpl: successfulProbeFetch() });
    expect(report.checks.some((entry) => entry.id === "wiring/server-actions")).toBe(false);
  });

  /** VendoRoot is gone (spec 2026-08-06 §B2): a host that still names it —
      or still carries the wrapper init used to generate — gets the swap by
      name, as a warning, not a build error it has to decode. */
  it("warns E-WIRE-010 when the host still carries the legacy vendo-root wrapper", async () => {
    const root = await healthy();
    await mkdir(join(root, "vendo"), { recursive: true });
    await writeFile(join(root, "vendo", "vendo-root.tsx"),
      "\"use client\";\nexport function VendoRoot({children}) { return <VendoProvider>{children}<VendoOverlay /></VendoProvider>; }");
    const { report } = await jsonChecks({ targetDir: root, fetchImpl: successfulProbeFetch() });
    expect(report.checks.find((check) => check.id === "wiring/vendo-root")).toMatchObject({
      status: "warning",
      error_code: "E-WIRE-010",
    });
  });

  /** …and a host whose OWN component happens to be named VendoRoot is not
      carrying anything legacy: Maple's src/components/vendo/VendoRoot.tsx is a
      local wrapper around <VendoProvider>, and a healthy install was told to
      swap a component Vendo never shipped it. The name alone proves nothing —
      the import source and the missing provider do. */
  it("stays silent on a local component merely NAMED VendoRoot that wraps <VendoProvider>", async () => {
    const root = await healthy();
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components", "VendoRoot.tsx"),
      "\"use client\";\nimport { VendoProvider } from \"@vendoai/vendo/react\";\n"
      + "export function VendoRoot({children}) { return <VendoProvider baseUrl=\"/api/vendo\">{children}</VendoProvider>; }");
    await writeFile(join(root, "app", "layout.tsx"),
      "import { VendoRoot } from \"@/components/VendoRoot\";\n"
      + "export default ({children}) => <VendoRoot>{children}<VendoOverlay /></VendoRoot>;");
    const { report } = await jsonChecks({ targetDir: root, fetchImpl: successfulProbeFetch() });
    expect(report.checks.find((check) => check.id === "wiring/vendo-root")).toBeUndefined();
  });

  it("accepts a BYO embed (<VendoToolResult>) as the visible surface", async () => {
    const root = await healthy();
    await writeFile(join(root, "app", "layout.tsx"),
      "export default ({children}) => <VendoProvider>{children}</VendoProvider>;");
    await mkdir(join(root, "app", "chat"), { recursive: true });
    await writeFile(join(root, "app", "chat", "page.tsx"),
      "export default () => <VendoToolResult output={null} />;");
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: output().sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
  });

  // E-WIRE-004 broadened: hosts with route groups or i18n mount in a NESTED
  // layout (invoify: app/[locale]/layout.tsx) — the root-layout-only grep
  // fought exactly that correct wiring in the 0.4.1 E2E cert.
  it("finds the <VendoProvider> mount in a nested layout", async () => {
    const root = await healthy();
    await writeFile(join(root, "app", "layout.tsx"),
      "export default ({children}) => <html><body>{children}</body></html>;");
    await mkdir(join(root, "app", "[locale]"), { recursive: true });
    await writeFile(join(root, "app", "[locale]", "layout.tsx"),
      "export default ({children}) => <VendoProvider>{children}<VendoOverlay /></VendoProvider>;");
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: output().sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
  });

  // A pages-only Next host is a shape init explicitly supports: clientRoot()
  // hands the user `pages/_app.tsx` to paste into, because there is no app
  // layout to wrap. Doctor scanning app/ layouts only fails such a host
  // forever, and names a file init never mentioned and that does not exist.
  it("finds the <VendoProvider> mount in a Pages-Router host's pages/_app.tsx", async () => {
    const root = await healthy();
    await rm(join(root, "app", "layout.tsx"));
    await mkdir(join(root, "pages"), { recursive: true });
    await writeFile(join(root, "pages", "_app.tsx"),
      "export default ({Component, pageProps}) => <VendoProvider><Component {...pageProps} /><VendoOverlay /></VendoProvider>;");
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: output().sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
  });

  it("names pages/_app.tsx, not app/layout.tsx, when a Pages-Router host has no mount", async () => {
    const root = await healthy();
    await rm(join(root, "app", "layout.tsx"));
    await mkdir(join(root, "pages"), { recursive: true });
    await writeFile(join(root, "pages", "_app.tsx"),
      "export default ({Component, pageProps}) => <Component {...pageProps} />;");
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    const wire004 = messages.errors.join("\n");
    expect(wire004).toContain(join("pages", "_app.tsx"));
    expect(wire004).not.toContain(join("app", "layout.tsx"));
  });

  // Render gate (0.4.1 E2E cert M3): the certified invoify install had every
  // page 500ing while doctor exited 0 — a live wire proves nothing about the
  // pages users load.
  it("fails E-LIVE-006 and exits 1 when the app's root page 500s while the wire answers", async () => {
    const root = await healthy();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://localhost:3000/") return new Response("boom", { status: 500 });
      if (url.endsWith("/status")) return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
      if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
      return Response.json({}, { status: 404 });
    });
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toContain("root page returned 500");
  });

  // The other half of the render gate: it fails on 5xx and blessed EVERYTHING
  // else, so `ok: the app's root page renders (HTTP 404)` was the line every
  // healthy run printed. A 404 is the one status that means the opposite — no
  // page is served at `/` — which the catch below already calls none of doctor's
  // business. So the probe may report the status it saw; it may not claim a
  // render it never observed.
  it("does not claim the root page renders when the origin answers 404", async () => {
    const root = await healthy();
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch() as unknown as typeof fetch,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    const rootLines = [...messages.logs, ...messages.errors].filter((line) => line.includes("root page"));
    expect(rootLines.join("\n")).toContain("404");
    expect(rootLines.some((line) => line.startsWith("ok:"))).toBe(false);
    expect(rootLines.join("\n")).not.toContain("renders");
  });

  // A 2xx proves the server answered, not that the page is correct — so the pass
  // says what was observed rather than asserting a render doctor cannot see.
  it("reports the observed status when the root page answers 200", async () => {
    const root = await healthy();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://localhost:3000/") return new Response("<html></html>", { status: 200 });
      if (url.endsWith("/status")) return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud" } });
      if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
      if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
      return Response.json({}, { status: 404 });
    });
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs.join("\n")).toContain("ok: the app's root page answered HTTP 200");
  });

  // Split-brain guard (0.4.2 re-run): a direct @vendoai/vendo dep pinned to
  // an older range beats the vendoai umbrella's for the app import, so the
  // CLI upgrades while /status silently serves the old runtime.
  it("fails E-DEP-002 with the exact fix when the wire's version disagrees with the CLI", async () => {
    const root = await healthy();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/status")) return Response.json({ posture: "unconfigured", version: "0.4.1", blocks: { store: true, sandbox: "cloud" } });
      if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
      if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
      return Response.json({}, { status: 404 });
    });
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    const errors = messages.errors.join("\n");
    expect(errors).toContain(`serves @vendoai/vendo 0.4.1 but this CLI is ${CLI_VERSION}`);
    expect(errors).toContain(`npm install @vendoai/vendo@${CLI_VERSION}`);
    expect(errors).toContain("restart the dev server");
  });

  it("passes the version-skew check when CLI and wire agree", async () => {
    const root = await healthy();
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs.join("\n")).toContain(`CLI and running wire agree on @vendoai/vendo ${CLI_VERSION}`);
  });

  // Exit-code honesty (3b): a failing live model turn is a broken: line AND
  // a nonzero exit — never a green verdict with broken output.
  it("a broken live model turn prints broken: and exits 1", async () => {
    const root = await healthy();
    const messages = output();
    expect(await doctor({
      targetDir: root,
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      liveTurn: async () => ({
        attempted: true,
        ok: false,
        rung: "none",
        credential: "no credential",
        error: "no reply text arrived",
        elapsedMs: 5,
      }),
    })).toBe(1);
    expect(messages.errors.join("\n")).toContain("broken: live model turn did not answer");
  });

  // --url copy (D8): a wrong --url should name the wire base it expects.
  it("the unreachable-/status failure names the wire base --url expects", async () => {
    const root = await healthy();
    const messages = output();
    expect(await doctor({
      targetDir: root,
      url: "http://localhost:4999",
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toContain("e.g. http://localhost:3000/api/vendo");
  });
});

function discoveryFetch(challenge?: string): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/vendo/status")) {
      return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { mcp: true, sandbox: "cloud" } });
    }
    if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
    if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
    if (url.includes("/.well-known/oauth-protected-resource/")) return Response.json({ resource: "mcp" });
    if (url.includes("/.well-known/oauth-authorization-server/")) return Response.json({ issuer: "auth" });
    if (url.endsWith("/.well-known/mcp/server-card.json")) {
      return Response.json({
        name: "maple",
        transports: [{ type: "streamable-http", url: "https://mcp.example.com/api/vendo/mcp" }],
      });
    }
    if (url.endsWith("/.well-known/mcp-registry-auth")) {
      return challenge === undefined
        ? new Response("not found", { status: 404 })
        : new Response(challenge, { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
}

describe("readEnvFiles — the CLI's one env reader (doctor and config read it too)", () => {
  it("reads .env.local over .env, parses quotes/comments, never overrides process env at the merge site", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-env-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, ".env"), "SHARED=from-env\nENV_ONLY=plain\n");
    await writeFile(
      join(root, ".env.local"),
      "# comment\nSHARED=from-local\nVENDO_API_KEY=\"vnd_0123\"\nexport EXPORTED=yes\nEMPTY=\nBROKEN LINE\n",
    );
    const { readEnvFiles } = await import("../../src/cli/sync-flow.js");
    const env = await readEnvFiles(root, {});
    expect(env["SHARED"]).toBe("from-local");
    expect(env["ENV_ONLY"]).toBe("plain");
    expect(env["VENDO_API_KEY"]).toBe("vnd_0123");
    expect(env["EXPORTED"]).toBe("yes");
    expect(env["EMPTY"]).toBe("");
    expect(Object.keys(env)).not.toContain("BROKEN LINE");
  });

  it("strips inline comments from unquoted values, same grammar as envFileValueSync", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-envc-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, ".env.local"), "VENDO_API_KEY=vnd_abc # dev key\nQUOTED=\"kept # inside\"\n");
    const { readEnvFiles } = await import("../../src/cli/sync-flow.js");
    const env = await readEnvFiles(root, {});
    expect(env["VENDO_API_KEY"]).toBe("vnd_abc");
    expect(env["QUOTED"]).toBe("kept # inside");
  });

  it("blank process values yield to concrete dotenv values at the merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-envm-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, ".env"), "VENDO_API_KEY=vnd_real\nONLY_FILE=x\nSHELL_WINS=from-file\n");
    const { readEnvFiles } = await import("../../src/cli/sync-flow.js");
    const merged = await readEnvFiles(root, { VENDO_API_KEY: "  ", SHELL_WINS: "yes", ONLY_PROC: "" });
    expect(merged["VENDO_API_KEY"]).toBe("vnd_real");
    expect(merged["ONLY_FILE"]).toBe("x");
    expect(merged["SHELL_WINS"]).toBe("yes");
    expect(merged["ONLY_PROC"]).toBe("");
  });

  it("returns only the process env when no env files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-noenv-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const { readEnvFiles } = await import("../../src/cli/sync-flow.js");
    expect(await readEnvFiles(root, {})).toEqual({});
  });
});
