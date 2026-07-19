import { describe, expect, it } from "vitest";
import { sandboxAdapterConformance, type SandboxConformanceHarness } from "../adapter-conformance.js";
import type { SandboxMachine } from "../sandbox.js";
import { e2bSandbox } from "./index.js";

// ============================================================================
// execution-v2 Lane A LIVE lane — real E2B, real network, real snapshots.
// Gated on E2B_API_KEY + VENDO_LIVE_SANDBOX=1 (never runs in CI).
// Costs real sandbox-minutes; every machine is destroyed in afterEach/finally.
// ============================================================================

const LIVE = process.env.E2B_API_KEY !== undefined && process.env.VENDO_LIVE_SANDBOX === "1";
const decoder = new TextDecoder();
const LIVE_TIMEOUT_MS = 180_000;

/** The conformance app (see SandboxConformanceHarness contract), as a real
    node http server listening on the box's $PORT. */
const CONFORMANCE_SERVER_SOURCE = `
const http = require("node:http");
http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    const env = /^\\/conformance\\/env\\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(request.url);
    if (env) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(process.env[env[1]] ?? "");
      return;
    }
    const egress = /^\\/conformance\\/egress\\/(.+)$/.exec(request.url);
    if (egress) {
      let allowed = false;
      try {
        await fetch("https://" + decodeURIComponent(egress[1]) + "/", {
          signal: AbortSignal.timeout(5000),
          redirect: "manual",
        });
        allowed = true;
      } catch {}
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ allowed }));
      return;
    }
    if (request.method === "POST" && request.url === "/fn/echo") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.concat(chunks));
      return;
    }
    response.writeHead(404);
    response.end("");
  });
}).listen(Number(process.env.PORT || 8080));
`;

/** Install and start the conformance app through the ADAPTER-PRIVATE surface
    (in production the in-box agent owns the inside of the box). */
const bootstrap = async (machine: SandboxMachine): Promise<void> => {
  const box = machine as unknown as {
    exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
    files: { write(path: string, bytes: Uint8Array | string): Promise<void> };
  };
  await box.files.write("/app/server.js", CONFORMANCE_SERVER_SOURCE);
  const started = await box.exec(
    [
      "i=0",
      "while [ $i -lt 20 ]; do",
      "  if [ -f /tmp/vendo-conformance.pid ] && kill -0 $(cat /tmp/vendo-conformance.pid) 2>/dev/null; then exit 0; fi",
      "  i=$((i + 1))",
      "  sleep 0.1",
      "done",
      "nohup node /app/server.js >/tmp/vendo-conformance.log 2>&1 &",
      "echo $! >/tmp/vendo-conformance.pid",
    ].join("\n"),
    { cwd: "/app", timeoutMs: 15_000 },
  );
  expect(started.code).toBe(0);
};

const makeAdapter = () => e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 120_000 });

describe.skipIf(!LIVE)("e2bSandbox live", () => {
  const harness: SandboxConformanceHarness = {
    makeAdapter,
    bootstrap,
    enforcesAllowedDomains: true,
  };
  sandboxAdapterConformance("real E2B", harness);

  // The Lane A gate, verbatim: create → box serves a hello HTTP app →
  // request() returns it → snapshot() → stop → resume(ref) → request() again
  // → destroy. Logged so the transcript lands in the PR body as evidence.
  it("passes the Lane A live round-trip gate", async () => {
    const transcript: string[] = [];
    const log = (line: string): void => {
      transcript.push(line);
      console.log(`[lane-a-gate] ${line}`);
    };
    const adapter = makeAdapter();
    let created: SandboxMachine | undefined;
    let resumed: SandboxMachine | undefined;
    let ref: string | undefined;
    try {
      created = await adapter.create({ env: { PORT: "8080", HELLO: "hello from the box" } });
      log(`create → machine ${created.id}`);
      await bootstrap(created);
      log("bootstrap → hello app serving on $PORT");

      const first = await created.request({ method: "GET", path: "/conformance/env/HELLO" });
      log(`request → ${first.status} "${decoder.decode(first.body)}"`);
      expect(first.status).toBe(200);
      expect(decoder.decode(first.body)).toBe("hello from the box");

      ref = await created.snapshot();
      log(`snapshot → ${ref.slice(0, 24)}… (${ref.length} chars)`);
      await created.stop();
      log("stop → machine paused (snapshot-preserving)");

      resumed = await adapter.resume(ref);
      log(`resume(ref) → machine ${resumed.id}`);
      const second = await resumed.request({ method: "GET", path: "/conformance/env/HELLO" });
      log(`request → ${second.status} "${decoder.decode(second.body)}"`);
      expect(second.status).toBe(200);
      expect(decoder.decode(second.body)).toBe("hello from the box");
      expect(resumed.id).not.toBe(created.id);
    } finally {
      await Promise.all([
        created?.destroy().catch(() => undefined),
        resumed?.destroy().catch(() => undefined),
      ]);
      if (ref !== undefined) await adapter.destroy(ref).catch(() => undefined);
      log("destroy → both machines and the snapshot ref gone");
      console.log(`[lane-a-gate] TRANSCRIPT\n${transcript.join("\n")}`);
    }
  }, LIVE_TIMEOUT_MS);
});
