import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Wave 7 H2 item 3 — the pre-baked served-app scaffold must satisfy the skin
 * contract ON ITS OWN: the in-box agent copies it into /app and edits it, so
 * a scaffold that fails the host's own checks (GET / 200 text/html, the
 * {result}/{error} fn envelopes, GET /vendo.json) would poison every warm
 * layer-3 build. Boots the real scaffold server as a child process, exactly
 * like the box supervisor does.
 */

const scaffoldDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../box/scaffold");

const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

describe("served-app scaffold (the warm layer-3 start)", () => {
  let child: ChildProcess;
  let base: string;

  beforeAll(async () => {
    // The agent's own first move: copy the scaffold into the app dir.
    const appDir = mkdtempSync(path.join(tmpdir(), "vendo-scaffold-"));
    cpSync(scaffoldDir, appDir, { recursive: true });
    // The agent extends the fn table; prove the seam takes an edit.
    writeFileSync(path.join(appDir, "fns.js"), 'export const fns = { listInvoices: async () => ({ invoices: [{ id: "inv_1", status: "draft" }] }) };\n');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn("node", ["server.js"], { cwd: appDir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
    const deadline = Date.now() + 15_000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(`${base}/`).then((response) => response.ok, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(up).toBe(true);
  }, 20_000);

  afterAll(() => {
    child?.kill("SIGKILL");
  });

  it("serves GET / as 200 text/html (the host's served-root check)", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  it("serves GET /vendo.json verbatim", async () => {
    const response = await fetch(`${base}/vendo.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schedules: [], egress: [] });
  });

  it("answers a declared fn with the {result} envelope", async () => {
    const response = await fetch(`${base}/fn/listInvoices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { invoices: [{ id: "inv_1", status: "draft" }] } });
  });

  it("answers an unknown fn with the {error} envelope", async () => {
    const response = await fetch(`${base}/fn/nope`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not-found");
  });

  it("never treats inherited object properties as fns (/fn/toString is 404)", async () => {
    const response = await fetch(`${base}/fn/toString`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("refuses an oversized fn body with 413 instead of buffering it", async () => {
    const response = await fetch(`${base}/fn/listInvoices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { padding: "x".repeat(1024 * 1024 + 64) } }),
    }).catch(() => undefined);
    // The server may reset the connection mid-upload (req.destroy) or answer
    // 413; both refuse the buffer, neither is a 200.
    if (response !== undefined) expect(response.status).toBe(413);
  });

  it("answers HEAD / (the host keepalive probe) with 200", async () => {
    const response = await fetch(`${base}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
  });

  it("keeps the entry page self-contained with the vendoTheme hook (no CDN)", async () => {
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain("vendoTheme");
    expect(page).not.toMatch(/src="https?:\/\//);
    expect(page).not.toMatch(/href="https?:\/\//);
  });
});
