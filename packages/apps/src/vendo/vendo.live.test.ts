import { describe, expect, it } from "vitest";
import type { SandboxMachine } from "../sandbox.js";
import { vendoSandbox } from "./index.js";

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
      const response = await machine.request({ method: "POST", path: "/fn/echo", body: "vendo-live" });
      if (response.status === 200) return decoder.decode(response.body);
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw failure ?? new Error("Vendo listener did not become ready");
};

describe.skipIf(!(process.env.VENDO_API_KEY && process.env.VENDO_BROKER_URL))("vendoSandbox live", () => {
  it("creates, serves, snapshots, resumes, serves again, and stops", async () => {
    const adapter = vendoSandbox({
      apiKey: process.env.VENDO_API_KEY,
      baseUrl: process.env.VENDO_BROKER_URL,
      timeoutMs: 90_000,
    });
    const machine = await adapter.create({
      env: { PORT: "8080" },
      files: { "/app/server.js": serverSource },
    });
    let resumed: SandboxMachine | undefined;
    try {
      await expect(machine.exec("nohup node /app/server.js >/tmp/vendo-live.log 2>&1 &", {
        cwd: "/app",
        timeoutMs: 10_000,
      })).resolves.toMatchObject({ code: 0 });
      await expect(requestEventually(machine)).resolves.toBe("vendo-live");
      const snapshotRef = await machine.snapshot();
      resumed = await adapter.resume(snapshotRef);
      await expect(requestEventually(resumed)).resolves.toBe("vendo-live");
    } finally {
      await (resumed ?? machine).stop().catch(() => undefined);
    }
  }, 90_000);
});
