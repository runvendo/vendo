import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VENDO_APP_FORMAT, VendoError, type AppDocument } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servedAppScaffold } from "./index.js";

const app = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_scaffold",
  name: "Scaffold",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [{ id: "root", component: "Text", source: "prewired", props: { text: "Kept tree" } }],
  },
  ...overrides,
});

describe("servedAppScaffold", () => {
  it("refuses to scaffold an app without a kept tree", () => {
    expect(() => servedAppScaffold(app({ tree: undefined } as unknown as Partial<AppDocument>)))
      .toThrow(VendoError);
  });

  it("emits the complete self-contained served bundle for the kept tree", () => {
    const files = servedAppScaffold(app());
    const byPath = new Map(files.map((file) => [file.path, file.content]));

    expect([...byPath.keys()]).toEqual([
      "/app/tree.json",
      "/app/components.json",
      "/app/tree-renderer.js",
      "/app/index.html",
      "/app/.vendo/scaffold-server.cjs",
      "/app/.vendo/fetch-shim.cjs",
      "/app/start.sh",
    ]);
    expect(byPath.get("/app/tree.json")).toBe(JSON.stringify(app().tree));
    expect(byPath.get("/app/components.json")).toBe("{}");
    expect(byPath.get("/app/tree-renderer.js")).toContain("VendoServedTreeRenderer");
    expect(byPath.get("/app/index.html")).toContain('id="vendo-served-tree"');
    expect(byPath.get("/app/index.html")).toContain('src="/tree-renderer.js"');
    expect(byPath.get("/app/start.sh")).toContain("exec node /app/.vendo/scaffold-server.cjs");
    // ENG-290 M4 — the egress fetch shim ships in the bundle and start.sh
    // requires it into every node process the entry spawns.
    expect(byPath.get("/app/.vendo/fetch-shim.cjs")).toContain("VENDO_PROXY_URL");
    expect(byPath.get("/app/start.sh"))
      .toContain('export NODE_OPTIONS="--require /app/.vendo/fetch-shim.cjs');
  });

  it("carries the app's generated components into components.json", () => {
    const files = servedAppScaffold(app({
      components: { Gauge: "export default function Gauge() { return null; }" },
    }));
    const components = files.find((file) => file.path === "/app/components.json");
    expect(JSON.parse(components?.content ?? "")).toEqual({
      Gauge: "export default function Gauge() { return null; }",
    });
  });
});

describe("scaffold-server.cjs (real node process)", () => {
  let root: string;
  let server: ChildProcess;
  let base: string;

  const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vendo-scaffold-"));
    // The server addresses its assets as /app/*; relocate the whole bundle to a
    // writable root so the REAL server source runs unmodified except for paths.
    for (const file of servedAppScaffold(app())) {
      const target = join(root, file.path.replace(/^\/app\//, ""));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content.replaceAll("/app/", `${root}/`), "utf8");
    }
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(root, ".vendo/scaffold-server.cjs")], {
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    });
    let lastError: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await fetch(`${base}/tree.json`, { method: "HEAD" });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError ?? new Error("scaffold server did not become ready");
  }, 15_000);

  afterAll(async () => {
    server?.kill();
    await rm(root, { recursive: true, force: true });
  });

  it("serves the tree, components, renderer, and page with no-store caching", async () => {
    const tree = await fetch(`${base}/tree.json`);
    expect(tree.status).toBe(200);
    expect(tree.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(tree.headers.get("cache-control")).toBe("no-store");
    expect(await tree.json()).toEqual(app().tree);

    expect(await (await fetch(`${base}/components.json`)).json()).toEqual({});

    const renderer = await fetch(`${base}/tree-renderer.js`);
    expect(renderer.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await renderer.text()).toContain("VendoServedTreeRenderer");

    for (const path of ["/", "/index.html"]) {
      const page = await fetch(`${base}${path}`);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toContain('id="vendo-served-tree"');
    }
  });

  it("answers HEAD without a body", async () => {
    const head = await fetch(`${base}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("404s unknown routes and non-GET methods with the error envelope", async () => {
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not-found", message: "route not found" } });

    const post = await fetch(`${base}/tree.json`, { method: "POST" });
    expect(post.status).toBe(404);
  });

  it("does not expose sibling files outside the served allowlist", async () => {
    // start.sh and the server source itself sit next to the assets but are not routes.
    expect((await fetch(`${base}/start.sh`)).status).toBe(404);
    expect((await fetch(`${base}/.vendo/scaffold-server.cjs`)).status).toBe(404);
    expect((await fetch(`${base}/.vendo/fetch-shim.cjs`)).status).toBe(404);
  });
});
