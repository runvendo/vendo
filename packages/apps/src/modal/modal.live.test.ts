import { describe, expect, it } from "vitest";
import type { SandboxMachine } from "../sandbox.js";
import { modalSandbox } from "./index.js";

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
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await machine.request({ method: "POST", path: "/fn/echo", body: "modal-live" });
      if (response.status === 200) return decoder.decode(response.body);
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw failure ?? new Error("Modal listener did not become ready");
};

const hasModalCredentials = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);

describe.skipIf(!hasModalCredentials)("modalSandbox live", () => {
  it("creates, serves, snapshots disk, restores a new machine, serves again, and terminates", async () => {
    const adapter = modalSandbox({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
      timeoutMs: 90_000,
    });
    const machine = await adapter.create({
      env: { PORT: "8080" },
      files: { "/app/server.js": serverSource },
    });
    let resumed: SandboxMachine | undefined;
    try {
      await expect(machine.exec("true", { cwd: "/app", timeoutMs: 10_000 })).resolves.toMatchObject({ code: 0 });
      await expect(requestEventually(machine)).resolves.toBe("modal-live");
      const snapshotRef = await machine.snapshot();
      resumed = await adapter.resume(snapshotRef);
      await expect(requestEventually(resumed)).resolves.toBe("modal-live");
    } finally {
      await Promise.all([
        machine.stop().catch(() => undefined),
        resumed?.stop().catch(() => undefined),
      ]);
    }
  }, 90_000);
});
