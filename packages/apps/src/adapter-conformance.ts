import { describe, expect, it } from "vitest";
import type { SandboxAdapter } from "./sandbox.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Internal 06-apps §3 conformance suite shared by sandbox adapter fixtures. */
export const sandboxAdapterConformance = (
  name: string,
  makeAdapter: () => SandboxAdapter | Promise<SandboxAdapter>,
): void => {
  describe(`${name} SandboxAdapter conformance`, () => {
    it("creates, executes, snapshots, resumes, serves, and stops through the frozen seam", async () => {
      const adapter = await makeAdapter();
      const server = [
        "const http = require('node:http');",
        "http.createServer((req, res) => {",
        "  res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-vendo-listener': 'yes' });",
        "  res.end(req.url);",
        "}).listen(Number(process.env.PORT || 8080));",
      ].join("\n");
      const created = await adapter.create({
        env: { PORT: "8080", CONFORMANCE_VALUE: "present" },
        files: {
          "/app/server.js": server,
          "/app/seed.txt": "seed",
        },
      });

      await expect(created.exec("node /app/server.js >/tmp/vendo-conformance.log 2>&1 &", {
        cwd: "/app",
        timeoutMs: 10_000,
      })).resolves.toMatchObject({ code: 0 });
      expect(decoder.decode(await created.files.read("/app/seed.txt"))).toBe("seed");
      await created.files.write("/app/round-trip.bin", encoder.encode("survives"));
      expect(await created.files.list("/app")).toEqual(expect.arrayContaining(["round-trip.bin"]));

      const snapshotRef = await created.snapshot();
      const resumed = await adapter.resume(snapshotRef);
      expect(decoder.decode(await resumed.files.read("/app/round-trip.bin"))).toBe("survives");
      const response = await resumed.request({ method: "GET", path: "/conformance" });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(500);
      expect(response.body).toBeInstanceOf(Uint8Array);

      await resumed.stop();
    });
  });
};
