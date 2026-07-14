import { describe, expect, it } from "vitest";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TEST_TIMEOUT_MS = 180_000;

const serverSource = [
  "const fs = require('node:fs');",
  "const http = require('node:http');",
  "fs.writeFileSync('/tmp/vendo-conformance.pid', String(process.pid));",
  "http.createServer((req, res) => {",
  "  res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-vendo-listener': 'yes' });",
  "  res.end(req.url);",
  "}).listen(Number(process.env.PORT || 8080));",
].join("\n");

const ensureServer = async (machine: SandboxMachine): Promise<void> => {
  const command = [
    "i=0",
    "while [ $i -lt 20 ]; do",
    "  if [ -f /tmp/vendo-conformance.pid ] && kill -0 $(cat /tmp/vendo-conformance.pid) 2>/dev/null; then exit 0; fi",
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    "nohup node /app/server.js >/tmp/vendo-conformance.log 2>&1 &",
    "echo $! >/tmp/vendo-conformance.pid",
  ].join("\n");
  await expect(machine.exec(command, { cwd: "/app", timeoutMs: 10_000 })).resolves.toMatchObject({ code: 0 });
};

const requestEventually = async (machine: SandboxMachine, path: string): Promise<void> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await machine.request({ method: "GET", path });
      if (response.status >= 200 && response.status < 500) {
        expect(response.body).toBeInstanceOf(Uint8Array);
        return;
      }
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw failure ?? new Error(`sandbox listener did not serve ${path}`);
};

/** Internal 06-apps §3 conformance suite shared by fake and live sandbox adapters. */
export const sandboxAdapterConformance = (
  name: string,
  makeAdapter: () => SandboxAdapter | Promise<SandboxAdapter>,
): void => {
  describe(`${name} SandboxAdapter conformance`, () => {
    it("creates, executes, snapshots, resumes, serves, and stops through the frozen seam", async () => {
      const adapter = await makeAdapter();
      const created = await adapter.create({
        env: { PORT: "8080", CONFORMANCE_VALUE: "present" },
        files: {
          "/app/server.js": serverSource,
          "/app/seed.txt": "seed",
        },
      });
      let resumed: SandboxMachine | undefined;
      try {
        await ensureServer(created);
        expect(decoder.decode(await created.files.read("/app/seed.txt"))).toBe("seed");
        await created.files.write("/app/round-trip.bin", encoder.encode("survives"));
        expect(await created.files.list("/app")).toEqual(expect.arrayContaining(["round-trip.bin"]));

        const snapshotRef = await created.snapshot();
        resumed = await adapter.resume(snapshotRef);
        expect(decoder.decode(await resumed.files.read("/app/round-trip.bin"))).toBe("survives");
        await requestEventually(resumed, "/conformance");
      } finally {
        await Promise.all([
          created.stop().catch(() => undefined),
          resumed?.stop().catch(() => undefined),
        ]);
      }
    }, TEST_TIMEOUT_MS);

    it("forks into an independent machine without disrupting the live source", async () => {
      const sourceAdapter = await makeAdapter();
      const source = await sourceAdapter.create({
        env: { PORT: "8080" },
        files: {
          "/app/server.js": serverSource,
          "/app/value.txt": "source",
        },
      });
      let fork: SandboxMachine | undefined;
      try {
        await ensureServer(source);
        await requestEventually(source, "/before-fork");
        const sourceRef = await source.snapshot();
        await requestEventually(source, "/after-source-snapshot");

        fork = await (await makeAdapter()).resume(sourceRef);
        expect(fork.id).not.toBe(source.id);
        await fork.files.write("/app/value.txt", "fork");
        expect(decoder.decode(await source.files.read("/app/value.txt"))).toBe("source");

        await fork.snapshot();
        await requestEventually(source, "/after-fork-snapshot");
        expect(decoder.decode(await source.files.read("/app/value.txt"))).toBe("source");
      } finally {
        await Promise.all([
          source.stop().catch(() => undefined),
          fork?.stop().catch(() => undefined),
        ]);
      }
    }, TEST_TIMEOUT_MS);

    it("restores env, egress, and port through a fresh adapter instance", async () => {
      const firstAdapter = await makeAdapter();
      const created = await firstAdapter.create({
        env: { PORT: "9090", CONFORMANCE_VALUE: "durable" },
        egress: [],
        files: { "/app/server.js": serverSource },
      });
      let resumed: SandboxMachine | undefined;
      try {
        await ensureServer(created);
        const snapshotRef = await created.snapshot();
        resumed = await (await makeAdapter()).resume(snapshotRef);

        await expect(resumed.exec("printf '%s' \"$CONFORMANCE_VALUE\"", { timeoutMs: 10_000 })).resolves.toMatchObject({
          code: 0,
          stdout: "durable",
        });
        await requestEventually(resumed, "/durable-port");
        const outbound = await resumed.exec(
          "timeout 5 node -e \"fetch('https://example.com').then(() => process.exit(0)).catch(() => process.exit(1))\"",
          { timeoutMs: 10_000 },
        );
        expect(outbound.code).not.toBe(0);
      } finally {
        await Promise.all([
          created.stop().catch(() => undefined),
          resumed?.stop().catch(() => undefined),
        ]);
      }
    }, TEST_TIMEOUT_MS);
  });
};
