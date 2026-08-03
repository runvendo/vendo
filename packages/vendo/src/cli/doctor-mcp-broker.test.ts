import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "./doctor.js";
import { CLOUD_UNLOCKS } from "./doctor-live.js";
import { CLI_VERSION } from "./shared.js";

// Task B3 of the MCP broker provisioning plan: doctor explains the broker
// seam's silent decisions. The seam skips the hosted broker without a word
// when the base URL is private (the broker cannot forward visitors to a
// laptop) — doctor is where that gets said (I-CLOUD-002, informational). With
// a public URL it resolves and prints the tenant the composition WOULD/did
// front the door with (the ensure is idempotent — the same call the boot
// makes). Patterns follow doctor.test.ts; this is a NEW file so the
// pre-existing suite stays untouched.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function output(): { logs: string[]; errors: string[]; sink: { log(message: string): void; error(message: string): void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    sink: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
  };
}

/** The healthy Next.js fixture from doctor.test.ts, trimmed to what the
 *  static checks need to stay green. */
async function healthy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-broker-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({ dependencies: { "@vendoai/vendo": "0.3.0", next: "16" } }));
  await write("app/layout.tsx", "export default ({children}) => <VendoRoot>{children}<VendoOverlay /></VendoRoot>;");
  await write("app/api/vendo/[...vendo]/route.ts", "export const GET = () => {};\n");
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

/** A live wire whose /status reports the given mcp posture, with the door's
 *  discovery documents and the doctor probes all answering. */
function probeFetch(mcp: unknown): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/vendo/status")) {
      return Response.json({ posture: "unconfigured", version: CLI_VERSION, blocks: { store: true, sandbox: "cloud", mcp } });
    }
    if (url.endsWith("/doctor/present")) return Response.json({ ok: true });
    if (url.endsWith("/doctor/act-as")) return Response.json({ ok: true });
    if (url.endsWith("/doctor/machines")) return Response.json({ scheduleCallerConfigured: false, machines: [] });
    if (url.includes("/.well-known/oauth-protected-resource/")) return Response.json({ resource: "mcp" });
    if (url.includes("/.well-known/oauth-authorization-server/")) return Response.json({ issuer: "auth" });
    if (url.endsWith("/.well-known/mcp/server-card.json")) {
      return Response.json({ name: "maple", transports: [{ type: "streamable-http", url: "http://localhost:3000/api/vendo/mcp" }] });
    }
    if (url.endsWith("/.well-known/mcp-registry-auth")) return new Response("not found", { status: 404 });
    if (new URL(url).pathname === "/") return new Response("<html />", { status: 200 });
    return Response.json({ error: { message: "unexpected probe" } }, { status: 404 });
  }) as typeof fetch;
}

const ensured = {
  tenant: {
    slug: "maple",
    issuer: "https://maple.mcp.vendo.run",
    audience: "https://maple.mcp.vendo.run/mcp",
    status: "active" as const,
    upstreamOrigin: "https://app.maplebank.com",
    upstreamMount: "/api/vendo/mcp",
  },
  federationSecret: "c2VjcmV0",
};

async function brokerDoctor(options: {
  env: Record<string, string | undefined>;
  mcp?: unknown;
  cloudOk?: boolean;
  ensureTenant?: Parameters<typeof runDoctor>[0]["ensureTenant"];
}): Promise<{ exit: number; logs: string[]; errors: string[] }> {
  const root = await healthy();
  const messages = output();
  const exit = await runDoctor({
    targetDir: root,
    env: options.env,
    interactive: false,
    fetchImpl: probeFetch(options.mcp ?? "local"),
    output: messages.sink,
    telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    liveTurn: async () => ({
      attempted: true,
      ok: true,
      rung: "env-key",
      credential: "explicit ANTHROPIC_API_KEY (anthropic)",
      reply: "ok",
      elapsedMs: 1,
    }),
    cloudProbe: async () => (options.cloudOk === false
      ? { present: false, ok: false, unlocks: CLOUD_UNLOCKS }
      : { present: true, ok: true, unlocks: CLOUD_UNLOCKS }),
    npmLatest: async () => null,
    ...(options.ensureTenant === undefined ? {} : { ensureTenant: options.ensureTenant }),
  });
  return { exit, logs: messages.logs, errors: messages.errors };
}

describe("doctor: the hosted MCP broker seam", () => {
  it("key + mcp + no public base URL → the I-CLOUD-002 informational, and no ensure call", async () => {
    const ensureTenant = vi.fn(async () => ensured);
    const { logs } = await brokerDoctor({ env: { VENDO_API_KEY: "vnd_" + "a".repeat(40) }, ensureTenant });
    const line = logs.find((entry) => entry.includes("I-CLOUD-002"));
    expect(line).toBeDefined();
    expect(line).toMatch(/public (base )?URL/i);
    expect(ensureTenant).not.toHaveBeenCalled();
  });

  it("a localhost VENDO_BASE_URL gets the same informational — the frozen localhost rule, explained", async () => {
    const ensureTenant = vi.fn(async () => ensured);
    const { logs } = await brokerDoctor({
      env: { VENDO_API_KEY: "vnd_" + "a".repeat(40), VENDO_BASE_URL: "http://localhost:3000" },
      ensureTenant,
    });
    expect(logs.some((entry) => entry.includes("I-CLOUD-002"))).toBe(true);
    expect(ensureTenant).not.toHaveBeenCalled();
  });

  it("key + mcp + public base URL → resolves and prints the tenant the door composes against", async () => {
    const ensureTenant = vi.fn(async () => ensured);
    const { logs } = await brokerDoctor({
      env: { VENDO_API_KEY: "vnd_" + "a".repeat(40), VENDO_BASE_URL: "https://app.maplebank.com" },
      mcp: "broker",
      ensureTenant,
    });
    expect(ensureTenant).toHaveBeenCalledTimes(1);
    expect(ensureTenant).toHaveBeenCalledWith({
      baseUrl: "https://app.maplebank.com",
      mount: "/api/vendo/mcp",
    });
    expect(logs.some((entry) => entry.includes("https://maple.mcp.vendo.run"))).toBe(true);
  });

  it("an ensure failure stays informational — named, never a doctor failure of its own", async () => {
    const ensureTenant = vi.fn(async () => { throw new Error("console unreachable"); });
    const { logs, errors } = await brokerDoctor({
      env: { VENDO_API_KEY: "vnd_" + "a".repeat(40), VENDO_BASE_URL: "https://app.maplebank.com" },
      mcp: "broker",
      ensureTenant,
    });
    expect(logs.some((entry) => entry.includes("console unreachable"))).toBe(true);
    expect(errors.join("\n")).not.toContain("console unreachable");
  });

  it("no usable key → no broker line at all", async () => {
    const ensureTenant = vi.fn(async () => ensured);
    const { logs } = await brokerDoctor({
      env: { VENDO_BASE_URL: "https://app.maplebank.com" },
      cloudOk: false,
      ensureTenant,
    });
    expect(logs.some((entry) => entry.includes("I-CLOUD-002"))).toBe(false);
    expect(ensureTenant).not.toHaveBeenCalled();
  });

  it("the new /status postures still count as an open door — the E-MCP discovery checks run", async () => {
    for (const mcp of ["local", "broker"]) {
      const { logs } = await brokerDoctor({
        env: { VENDO_API_KEY: "vnd_" + "a".repeat(40), VENDO_BASE_URL: "https://app.maplebank.com" },
        mcp,
        ensureTenant: vi.fn(async () => ensured),
      });
      expect(logs.some((entry) => entry.includes("MCP protected-resource metadata resolves")), mcp).toBe(true);
    }
  });

  it("CLOUD_UNLOCKS truthfully names the hosted MCP broker again, with its deploy condition", async () => {
    const unlock = CLOUD_UNLOCKS.find((entry) => entry.includes("MCP broker"));
    expect(unlock).toBeDefined();
    expect(unlock).toMatch(/public/i);
  });
});
