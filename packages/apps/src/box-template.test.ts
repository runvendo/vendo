import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The universal box app template must satisfy the skin contract ON ITS OWN: a
 * box provisions it into /app and the in-box agent edits it, so a template that
 * fails the host's own checks (GET / 200 text/html, the {result}/{error} fn
 * envelopes, GET /vendo.json) would poison every served build. Provisions the
 * REAL template exactly as the box does, builds it with the REAL toolchain, and
 * boots the REAL server as a child process, exactly like the box supervisor.
 *
 * Succeeds the zero-dependency scaffold's conformance test (box-scaffold.test.ts)
 * — same eight assertions, plus the two the Vite build introduces: relative asset
 * URLs (the served proxy mounts the app under /apps/<id>/serve/, so an absolute
 * /assets/ URL escapes the mount) and a real hashed asset actually served.
 */

const templateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../box-template");

const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

/** What `cp -a /opt/vendo-box/template/. /app/` does in the box: every template
 *  file, `run` landed at `.vendo/run`, and node_modules as the SYMLINK the bake
 *  leaves behind (deps are installed once into the image, never per build). */
const provision = (): string => {
  const appDir = path.join(mkdtempSync(path.join(tmpdir(), "vendo-template-")), "app");
  const skipped = new Set(["node_modules", "dist"]);
  cpSync(templateDir, appDir, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(templateDir, source);
      return rel === "" || !skipped.has(rel.split(path.sep)[0]!);
    },
  });
  symlinkSync(path.join(templateDir, "node_modules"), path.join(appDir, "node_modules"), "dir");
  mkdirSync(path.join(appDir, ".vendo"), { recursive: true });
  cpSync(path.join(templateDir, "run"), path.join(appDir, ".vendo", "run"));
  return appDir;
};

describe("box app template (the served-app warm start)", () => {
  let child: ChildProcess;
  let base: string;
  let appDir: string;

  beforeAll(async () => {
    appDir = provision();
    // The agent's own edit: extend the fn table. Proves the seam takes an edit.
    writeFileSync(
      path.join(appDir, "fns.js"),
      'export const fns = { listInvoices: async () => ({ invoices: [{ id: "inv_1", status: "draft" }] }) };\n',
    );
    // The REAL toolchain is the code validator (no bespoke syntax checking).
    const built = spawnSync("npm", ["run", "build", "--silent"], { cwd: appDir, encoding: "utf8" });
    expect(built.stderr ?? "", `vite build failed:\n${built.stdout}\n${built.stderr}`).not.toMatch(/error/i);
    expect(built.status).toBe(0);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn("node", ["server.js"], { cwd: appDir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
    // The boot poll's budget stays well inside this test's own timeout: the
    // timeout is the hang detector, a tighter inner budget is a second one.
    const deadline = Date.now() + 60_000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(`${base}/`).then((response) => response.ok, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(up).toBe(true);
  }, 300_000);

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

  it("keeps the entry page self-contained (no CDN) and carries the theme hook", async () => {
    const page = await (await fetch(`${base}/`)).text();
    expect(page).not.toMatch(/src="https?:\/\//);
    expect(page).not.toMatch(/href="https?:\/\//);
    // The vendoTheme reader now lives in the built bundle rather than an inline
    // script, so follow the entry module and assert the hook is really there.
    const entry = /src="([^"]+\.js)"/.exec(page)?.[1];
    expect(entry).toBeDefined();
    const bundle = await (await fetch(new URL(entry!, `${base}/`))).text();
    expect(bundle).toContain("vendoTheme");
  });

  it("references every built asset RELATIVELY (the served proxy mounts it under a path prefix)", async () => {
    const page = await (await fetch(`${base}/`)).text();
    // `/apps/<id>/serve/` is the mount; an absolute `/assets/...` URL leaves it
    // and 404s on the host origin, so `base: "./"` is load-bearing, not taste.
    expect(page).not.toMatch(/(?:src|href)="\/[^/]/);
    expect(page).toMatch(/(?:src|href)="\.\/assets\//);
  });

  it("serves the built hashed assets with their own content types", async () => {
    const page = await (await fetch(`${base}/`)).text();
    const entry = /src="([^"]+\.js)"/.exec(page)?.[1];
    const response = await fetch(new URL(entry!, `${base}/`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  it("refuses to serve anything outside the build output", async () => {
    // Encoded, because fetch normalizes a literal `../` away before it is sent:
    // the raw pathname would never reach the server, so the guard is only really
    // exercised by an escape the URL parser leaves intact.
    const response = await fetch(`${base}/assets/%2e%2e%2f%2e%2e%2fpackage.json`);
    expect(response.status).toBe(404);
  });
});

/**
 * Contract §3.2 rebuildability, template half: an app provisioned fresh from the
 * template plus `doc.source`, with the snapshot DELETED, must build and serve.
 * Losing a snapshot must not lose an app, so source files and the template alone
 * have to be sufficient — no build output, and no network.
 */
describe("box app template (a cold provision, no snapshot)", () => {
  let child: ChildProcess;
  let base: string;

  beforeAll(async () => {
    const appDir = provision();
    // What a checkout writes: the app's OWN source, and nothing built.
    writeFileSync(
      path.join(appDir, "fns.js"),
      'export const fns = { restored: async () => ({ from: "source" }) };\n',
    );
    expect(existsSync(path.join(appDir, "dist"))).toBe(false);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // No pre-build: `node server.js` IS the whole recovery, exactly as the
    // supervisor runs the `.vendo/run` line. The registry points at a dead
    // address so a build that tried to reach one would fail loudly rather than
    // pass on this machine and break in the egress-denied box.
    child = spawn("node", ["server.js"], {
      cwd: appDir,
      env: { ...process.env, PORT: String(port), npm_config_registry: "http://127.0.0.1:1", npm_config_offline: "true" },
      stdio: "ignore",
    });
    const deadline = Date.now() + 120_000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(`${base}/`).then((response) => response.ok, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(up).toBe(true);
  }, 300_000);

  afterAll(() => {
    child?.kill("SIGKILL");
  });

  it("builds itself from source alone and serves the app", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toMatch(/(?:src|href)="\.\/assets\//);
  });

  it("serves the restored app's own fns", async () => {
    const response = await fetch(`${base}/fn/restored`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { from: "source" } });
  });
});
