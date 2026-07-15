import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "./doctor.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function healthy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-"));
  cleanup.push(root);
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
  cleanup.push(root);
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

describe("vendo doctor", () => {
  it("checks Express server and client wiring instead of Next files", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      posture: "unconfigured",
      version: "0.3.0",
      blocks: { store: true },
    }));
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
      fetchImpl: vi.fn().mockResolvedValue(Response.json({
        posture: "unconfigured",
        version: "0.3.0",
        blocks: { store: true },
      })),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toEqual(expect.arrayContaining([
      "broken: Express server is not wired with createVendo from @vendoai/vendo/server",
      "broken: Express client is not wrapped in <VendoRoot>",
    ]));
  });

  it("checks wiring and performs one live status round-trip", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      posture: "unconfigured",
      version: "0.3.0",
      blocks: { store: true },
    }));
    expect(await runDoctor({
      targetDir: await healthy(),
      fetchImpl,
      output: { log() {}, error() {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/vendo/status");
  });

  it("returns one for broken wiring or an unreachable live handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-broken-"));
    cleanup.push(root);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await runDoctor({ targetDir: root, fetchImpl, output: { log() {}, error() {} } })).toBe(1);
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
      return Response.json({ posture: "unconfigured", version: "0.3.0", blocks: { mcp: true } });
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
