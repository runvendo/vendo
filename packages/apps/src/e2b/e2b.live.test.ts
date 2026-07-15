import { describe, expect, it } from "vitest";
import { sandboxAdapterConformance } from "../adapter-conformance.js";
import type { SandboxMachine } from "../sandbox.js";
import { e2bSandbox } from "./index.js";

const decoder = new TextDecoder();

const serverSource = `
const http = require("node:http");
http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.concat(chunks));
  });
}).listen(Number(process.env.PORT || 8080));
`;

const requestEventually = async (machine: SandboxMachine): Promise<string> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await machine.request({ method: "POST", path: "/fn/echo", body: "e2b-live" });
      if (response.status === 200) return decoder.decode(response.body);
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw failure ?? new Error("E2B listener did not become ready");
};

describe.skipIf(!process.env.E2B_API_KEY)("e2bSandbox live", () => {
  sandboxAdapterConformance("real E2B", () => e2bSandbox({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 90_000,
  }));

  it("creates, serves, snapshots, forks, serves again, and kills", async () => {
    const adapter = e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 90_000 });
    const machine = await adapter.create({
      env: { PORT: "8080" },
      files: { "/app/server.js": serverSource },
    });
    let resumed: SandboxMachine | undefined;
    try {
      await expect(machine.exec("nohup node /app/server.js >/tmp/vendo-e2b-live.log 2>&1 &", {
        cwd: "/app",
        timeoutMs: 10_000,
      })).resolves.toMatchObject({ code: 0 });
      await expect(requestEventually(machine)).resolves.toBe("e2b-live");
      const snapshotRef = await machine.snapshot();
      resumed = await adapter.resume(snapshotRef);
      await expect(requestEventually(resumed)).resolves.toBe("e2b-live");
    } finally {
      await Promise.all([
        machine.stop().catch(() => undefined),
        resumed?.stop().catch(() => undefined),
      ]);
    }
  }, 90_000);
});
