import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActAs, PermissionGrant, Principal } from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../server.js";
import { runDoctor } from "./doctor.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function healthy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({ dependencies: { "@vendoai/vendo": "0.3.0", next: "16" } }));
  await write("app/layout.tsx", "export default ({children}) => <VendoRoot>{children}</VendoRoot>;");
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
    await write("src/client.tsx", "export const App = () => <VendoRoot><main /></VendoRoot>;\n");
  } else {
    await write("src/notes.ts", "/* TODO: import createVendo from @vendoai/vendo/server and render <VendoRoot> */\n");
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

function successfulProbeFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/status")) {
      return Response.json({ posture: "unconfigured", version: "0.3.0", blocks: { store: true, sandbox: "e2b" } });
    }
    if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
    if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
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
    expect(await runDoctor({
      targetDir: await expressHost(true),
      fetchImpl,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
    expect(messages.logs).toContain("ok: Express server is wired");
    expect(messages.logs).toContain("ok: <VendoRoot> wraps the client");
    expect(messages.logs.join("\n")).not.toContain("catch-all handler");
  });

  it("returns one when an Express host is missing server and client wiring", async () => {
    const messages = output();
    expect(await runDoctor({
      targetDir: await expressHost(false),
      fetchImpl: successfulProbeFetch(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toEqual(expect.arrayContaining([
      "broken: Express server is not wired with createVendo from @vendoai/vendo/server",
      "broken: Express client is not wrapped in <VendoRoot>",
    ]));
  });

  it("checks wiring and performs one live status round-trip", async () => {
    const fetchImpl = successfulProbeFetch();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl,
      output: { log() {}, error() {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/vendo/status");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://localhost:3000/api/vendo/doctor/present");
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("http://localhost:3000/api/vendo/doctor/act-as");
  });

  it.each(["e2b", "modal", "custom"] as const)("reports a lit %s execution venue", async (sandbox) => {
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl: vi.fn().mockResolvedValue(Response.json({
        posture: "unconfigured",
        version: "0.3.0",
        blocks: { store: true, sandbox },
      })),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toContain(`ok: execution venue: ${sandbox}`);
  });

  it("warns with actionable guidance when the execution venue is dark", async () => {
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl: vi.fn().mockResolvedValue(Response.json({
        posture: "unconfigured",
        version: "0.3.0",
        blocks: { store: true, sandbox: false },
      })),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toContain(
      "warning: install the e2b package and set E2B_API_KEY, or install modal and set MODAL_TOKEN_ID+MODAL_TOKEN_SECRET, or pass sandbox: to createVendo; without one, server apps (rungs 2-4) return sandbox-unavailable",
    );
    expect(messages.logs).toContain(
      "Ladder: execution venue is checked above; actAs for away host actions; connectors for external tools.",
    );
  });

  it("warns instead of failing when an older host omits the execution venue", async () => {
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl: vi.fn().mockResolvedValue(Response.json({
        posture: "unconfigured",
        version: "0.3.0",
        blocks: { store: true },
      })),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toContain(
      "warning: host /status does not report an execution venue; upgrade @vendoai/vendo to enable the venue check",
    );
  });

  it("fails when /status reports an unknown execution venue", async () => {
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl: vi.fn().mockResolvedValue(Response.json({
        posture: "unconfigured",
        version: "0.3.0",
        blocks: { store: true, sandbox: "mainframe" },
      })),
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
    expect(await runDoctor({ targetDir: root, fetchImpl, output: messages.sink })).toBe(1);
    expect(messages.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("start the dev server"),
      expect.stringContaining("cannot probe actAs"),
    ]));
  });

  it("proves present credentials and actAs mint+verify over a real booted server", async () => {
    const host = await liveHost();
    const messages = output();
    expect(await runDoctor({
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
    expect(await runDoctor({
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
    expect(await runDoctor({
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

    expect(await runDoctor({
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

    expect(await runDoctor({
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

    expect(await runDoctor({
      targetDir: root,
      url: "https://mcp.example.com/api/vendo",
      fetchImpl: discoveryFetch("not-an-mcp-challenge"),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toContain("broken: MCP registry auth challenge must start with v=MCPv1");
  });
});

function discoveryFetch(challenge?: string): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/vendo/status")) {
      return Response.json({ posture: "unconfigured", version: "0.3.0", blocks: { mcp: true, sandbox: "e2b" } });
    }
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
