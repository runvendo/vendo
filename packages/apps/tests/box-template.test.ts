import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devPortFrom, VENDO_APP_PORT, VENDO_DEV_PORT, VENDO_DEV_PORT_ENV } from "@vendoai/core";

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
const provision = (root: string): string => {
  const appDir = path.join(root, "app");
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
  // Created on the first line of beforeAll, before anything that can throw, so
  // afterAll (which vitest runs even when beforeAll fails) always has it.
  let appRoot: string | undefined;

  beforeAll(async () => {
    appRoot = mkdtempSync(path.join(tmpdir(), "vendo-template-"));
    appDir = provision(appRoot);
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
    // The poll's budget matches this test's own timeout, never undercuts it:
    // the timeout is the hang detector, and a TIGHTER inner budget is a second,
    // invisible speed limit — it would expire first on a busy machine and fail
    // the assertion below, reporting a product bug where there is only load.
    const deadline = Date.now() + 300_000;
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
  let appRoot: string | undefined;

  beforeAll(async () => {
    appRoot = mkdtempSync(path.join(tmpdir(), "vendo-template-"));
    const appDir = provision(appRoot);
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
    // Matches this test's own timeout — never tighter (see the note above).
    const deadline = Date.now() + 300_000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(`${base}/`).then((response) => response.ok, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(up).toBe(true);
  }, 300_000);

  afterAll(() => {
    child?.kill("SIGKILL");
    if (appRoot !== undefined) rmSync(appRoot, { recursive: true, force: true });
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

/**
 * The DECLARED dev-port contract (Track D's live preview).
 *
 * The preview URL is minted from a number — `SandboxMachine.url(port)` — before
 * the dev server has necessarily booted, so the port can never be discovered
 * post-boot. Two independent halves have to agree: the HOST, which sets
 * `VENDO_DEV_PORT` into the box at create, and the TEMPLATE, which binds the
 * socket.
 *
 * This BOOTS THE REAL DEV SERVER with a host-declared port and fetches it. An
 * earlier version of this test imported the vite config and fell back to
 * `devPortFrom` when the import failed — which compared core to core and stayed
 * green with the constant deliberately drifted. Nothing here may resolve the
 * expected port the same way the subject does.
 */
describe("the dev port is declared by the host, and the template binds it", () => {
  let dev: ChildProcess | undefined;
  let appRoot: string | undefined;

  afterAll(() => {
    // `npm run dev` is a WRAPPER: killing it leaves the vite child holding the
    // socket. Measured — a falsification run leaked a dev server onto 5173 and
    // the next run read it as a product failure. The spawn is `detached`, so
    // the whole process GROUP goes.
    if (dev?.pid !== undefined) {
      try {
        process.kill(-dev.pid, "SIGKILL");
      } catch {
        dev.kill("SIGKILL");
      }
    }
    // After the kill, never before: vite holds the app dir open until then.
    if (appRoot !== undefined) rmSync(appRoot, { recursive: true, force: true });
  });

  it("binds the port the host declared, not a compiled-in default", async () => {
    appRoot = mkdtempSync(path.join(tmpdir(), "vendo-template-"));
    const appDir = provision(appRoot);
    // Deliberately NOT the default: a template that ignores the declared value
    // and binds its own literal fails here.
    const declared = await freePort();
    expect(declared).not.toBe(VENDO_DEV_PORT);

    dev = spawn("npm", ["run", "dev", "--silent"], {
      cwd: appDir,
      env: { ...process.env, [VENDO_DEV_PORT_ENV]: String(declared) },
      stdio: "ignore",
      // Own the process group so afterAll can take the vite child with it.
      detached: true,
    });

    // Matches this test's own timeout, never tighter: the timeout is the hang
    // detector, and a tighter inner budget is a second, invisible speed limit.
    const deadline = Date.now() + 300_000;
    let served = false;
    while (!served && Date.now() < deadline) {
      served = await fetch(`http://127.0.0.1:${declared}/`).then((r) => r.ok, () => false);
      if (!served) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(served, `the dev server never answered on the declared port ${declared}`).toBe(true);
  }, 300_000);

  it("resolves nonsense to the declared default rather than binding NaN", () => {
    expect(devPortFrom({ [VENDO_DEV_PORT_ENV]: "6100" })).toBe(6100);
    for (const bad of ["", "   ", "nope", "0", "70000", "5173.5"]) {
      expect(devPortFrom({ [VENDO_DEV_PORT_ENV]: bad })).toBe(VENDO_DEV_PORT);
    }
    expect(devPortFrom({})).toBe(VENDO_DEV_PORT);
  });

  it("the three box ports are distinct", () => {
    // 8811 is the harness control port; the contract says three, all distinct.
    expect(new Set([VENDO_APP_PORT, VENDO_DEV_PORT, 8811]).size).toBe(3);
  });
});

/**
 * `rows.js` — the template's durable-rows client, exercised INSIDE a really
 * booted template, through the real `POST /fn/<name>` envelope. Nothing here
 * imports rows.js into the vitest process and nothing stubs fetch: the app's
 * server half calls it exactly as a generated app would.
 *
 * The endpoint below is a CONTRACT CHECKER, not a convenience stub. It asserts
 * the exact request shape the real box door requires (the bearer, the
 * `/rows/<collection>/<id>` path, `content-type: application/json` on PUT, a
 * `{data, refs?}` body with no other top-level key, no `refs.subject` filter)
 * and answers with the door's real envelopes. ANYTHING rows.js sends that the
 * real door would reject fails this test. The door's own half of this seam is
 * proven for real — against the real store — in
 * `packages/vendo/tests/box-wire.test.ts`.
 */
describe("the template's durable rows (rows.js against the box door's contract)", () => {
  const TOKEN = "app_tok_rows_test";
  /** The real VENDO_STORE_URL carries a path prefix (`.../api/vendo/box`), so
   *  the checker mounts under one: a client that ignored it would 404 here. */
  const PREFIX = "/box";

  let child: ChildProcess;
  let checker: Server;
  let base: string;
  let appRoot: string | undefined;
  const violations: string[] = [];
  const stored = new Map<string, unknown>();

  beforeAll(async () => {
    appRoot = mkdtempSync(path.join(tmpdir(), "vendo-template-"));
    const appDir = provision(appRoot);

    const storePort = await freePort();
    checker = createHttpServer((req, res) => {
      const reply = (status: number, value: unknown): void => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(value));
      };
      // A rejected request is recorded AND refused, so a bad shape shows up
      // both as a failed fn call and as a named violation.
      const refuse = (detail: string): void => {
        violations.push(detail);
        reply(400, { error: { code: "validation", message: detail } });
      };

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        refuse(`authorization must be the app token bearer, got ${String(req.headers.authorization)}`);
        return;
      }
      const segments = url.pathname.split("/").filter(Boolean);
      if (`/${segments[0]}` !== PREFIX || segments[1] !== "rows") {
        refuse(`path must be <store url>/rows/..., got ${url.pathname}`);
        return;
      }
      const collection = segments[2] ?? "";
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(collection) || segments.length > 4) {
        refuse(`bad rows path ${url.pathname}`);
        return;
      }
      const id = segments[3];

      if (id === undefined) {
        if (req.method !== "GET") {
          refuse(`a collection is listed with GET, got ${String(req.method)}`);
          return;
        }
        for (const key of url.searchParams.keys()) {
          // The door refuses every other parameter, and refuses refs.subject
          // outright: the owner is not the app's to filter on.
          if (key === "refs.subject" || !(key.startsWith("refs.") || key === "limit" || key === "cursor")) {
            refuse(`unknown list query parameter: ${key}`);
            return;
          }
        }
        reply(200, { records: [...stored.values()] });
        return;
      }

      if (id.length === 0 || id.length > 256) {
        refuse(`row id must be 1-256 characters, got ${id.length}`);
        return;
      }
      if (req.method === "GET") {
        const record = stored.get(id);
        if (record === undefined) reply(404, { error: { code: "not-found", message: `row not found: ${id}` } });
        else reply(200, record);
        return;
      }
      if (req.method === "DELETE") {
        stored.delete(id);
        reply(200, { status: "ok" });
        return;
      }
      if (req.method !== "PUT") {
        refuse(`unsupported method ${String(req.method)}`);
        return;
      }
      if (req.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
        refuse(`PUT needs content-type: application/json, got ${String(req.headers["content-type"])}`);
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {
          refuse("PUT body must be JSON");
          return;
        }
        const unexpected = Object.keys(body).find((key) => key !== "data" && key !== "refs");
        if (unexpected !== undefined) {
          refuse(`unexpected row property: ${unexpected}`);
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(body, "data")) {
          refuse("row body must contain data");
          return;
        }
        // The one id another user already holds: the door answers 409, never a
        // silent overwrite.
        if (id === "held_elsewhere") {
          reply(409, { error: { code: "conflict", message: `row ${id} belongs to another owner` } });
          return;
        }
        const record = { id, data: body["data"], ...(body["refs"] === undefined ? {} : { refs: body["refs"] }) };
        stored.set(id, record);
        reply(200, record);
      });
    });
    checker.listen(storePort, "127.0.0.1");
    await once(checker, "listening");

    // The app's server half, exactly as a generated app writes it.
    writeFileSync(path.join(appDir, "fns.js"), [
      'import { rows } from "./rows.js";',
      'const notes = rows("notes");',
      "export const fns = {",
      '  save: async ({ id, title }) => ({ record: await notes.put(id, { title }, { refs: { status: "open" } }) }),',
      "  read: async ({ id }) => ({ record: await notes.get(id) }),",
      "  all: async () => notes.list({ limit: 10 }),",
      "  remove: async ({ id }) => { await notes.delete(id); return { removed: true }; },",
      // The thrown error is caught HERE so the assertion can read its own
      // properties: an fn envelope only carries the message.
      "  taken: async () => {",
      '    try { await notes.put("held_elsewhere", { title: "mine" }); return { threw: false }; }',
      "    catch (error) { return { threw: true, code: error.code, status: error.status, message: error.message }; }",
      "  },",
      "};",
      "",
    ].join("\n"));

    const built = spawnSync("npm", ["run", "build", "--silent"], { cwd: appDir, encoding: "utf8" });
    expect(built.status, `vite build failed:\n${built.stdout}\n${built.stderr}`).toBe(0);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn("node", ["server.js"], {
      cwd: appDir,
      env: {
        ...process.env,
        PORT: String(port),
        VENDO_STORE_URL: `http://127.0.0.1:${storePort}${PREFIX}`,
        VENDO_APP_TOKEN: TOKEN,
      },
      stdio: "ignore",
    });
    // Matches this test's own timeout, never tighter (see the note above).
    const deadline = Date.now() + 300_000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(`${base}/`).then((response) => response.ok, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(up).toBe(true);
  }, 300_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    await new Promise((resolve) => checker?.close(resolve));
    if (appRoot !== undefined) rmSync(appRoot, { recursive: true, force: true });
  });

  const callFn = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await fetch(`${base}/fn/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args }),
    });
    const body = await response.json() as { result?: unknown; error?: { code: string; message: string } };
    if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
    return body.result;
  };

  it("puts a row and gets the stored record back", async () => {
    expect(await callFn("save", { id: "note_1", title: "Hello" })).toEqual({
      record: { id: "note_1", data: { title: "Hello" }, refs: { status: "open" } },
    });
    expect(await callFn("read", { id: "note_1" })).toEqual({
      record: { id: "note_1", data: { title: "Hello" }, refs: { status: "open" } },
    });
  });

  it("gets a missing row as null rather than throwing", async () => {
    expect(await callFn("read", { id: "never_written" })).toEqual({ record: null });
  });

  it("lists a collection as { records }", async () => {
    await callFn("save", { id: "note_2", title: "Second" });
    const listed = await callFn("all") as { records: { id: string }[] };
    expect(listed.records.map((record) => record.id)).toContain("note_2");
  });

  it("deletes a row", async () => {
    await callFn("save", { id: "note_3", title: "Doomed" });
    expect(await callFn("remove", { id: "note_3" })).toEqual({ removed: true });
    expect(await callFn("read", { id: "note_3" })).toEqual({ record: null });
  });

  it("surfaces a 409 as a thrown error carrying .code = conflict", async () => {
    expect(await callFn("taken")).toEqual({
      threw: true,
      code: "conflict",
      status: 409,
      message: "conflict: row held_elsewhere belongs to another owner",
    });
  });

  it("sent nothing the real box door would have refused", () => {
    expect(violations).toEqual([]);
  });
});
