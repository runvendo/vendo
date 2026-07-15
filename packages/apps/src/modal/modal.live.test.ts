import { describe, expect, it } from "vitest";
import { sandboxAdapterConformance } from "../adapter-conformance.js";
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
  sandboxAdapterConformance("real Modal", () => modalSandbox({
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
    timeoutMs: 90_000,
  }));

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

  // ENG-322 — Modal's outbound allowlists are additive and the SDK documents
  // outboundCidrAllowlist as "if not set, all CIDRs are allowed", so a domain
  // allowlist alone leaves raw-IP egress fail-open. The adapter now pins the
  // CIDR allowlist to [] whenever an egress policy is present; this proves it
  // against the real provider: a domain-allowlisted machine reaches its domain
  // but a raw-IP fetch (no domain to match, no allowlisted CIDR) must fail.
  it("blocks raw-IP egress from a domain-allowlisted sandbox (ENG-322 fail-closed)", async () => {
    const adapter = modalSandbox({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
      timeoutMs: 90_000,
    });
    const machine = await adapter.create({
      env: { PORT: "8080" },
      egress: ["postman-echo.com"],
    });
    try {
      const allowed = await machine.exec(
        "timeout 20 node -e \"fetch('https://postman-echo.com/get').then(() => process.exit(0)).catch(() => process.exit(1))\"",
        { timeoutMs: 30_000 },
      );
      expect(allowed.code).toBe(0);
      // 1.1.1.1 serves HTTPS on the bare IP: reachable from an unrestricted
      // machine, so a failure here is the network policy, not the target.
      const rawIp = await machine.exec(
        "timeout 20 node -e \"fetch('https://1.1.1.1/').then(() => process.exit(0)).catch(() => process.exit(1))\"",
        { timeoutMs: 30_000 },
      );
      expect(rawIp.code).not.toBe(0);
    } finally {
      await machine.stop().catch(() => undefined);
    }
  }, 120_000);
});
