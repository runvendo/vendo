// ENG-290 M3 — invisible-graduation demo on REAL E2B, real browser.
//
// One app climbs rung 1 → 2 → 3 → 4 through the REAL public runtime
// (createApps → edit/call/open) with a REAL e2bSandbox venue; the model is
// scripted so the climb is deterministic (the venue behavior is the demo, not
// generation). The page shows the app surface (the served-app tree renderer —
// the same PayloadView pipeline AppFrame uses) above a status bar. The
// surface pixels must stay IDENTICAL while the status bar proves the app is
// climbing: rung, surface kind, opaque e2b:v1: server ref, and a live
// fn:total answer once a machine exists. At rung 4 the surface swaps to an
// iframe of the app's real E2B machine URL serving the same kept tree.
//
// Run from the repo root after `pnpm install && pnpm build`:
//
//   set -a; source /Users/yousefh/orca/workspaces/flowlet/.env; set +a
//   node docs/verification/eng-290-m3/invisible-graduation.mjs
//
// Overwrites rung-1..4.png, surface-rung-1..4.png, and
// invisible-graduation.gif (needs ffmpeg) in this directory on success; exits
// nonzero on any rung, ref, fn, or pixel mismatch.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const requireFromUi = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
const { chromium } = requireFromUi("@playwright/test");

const { createApps } = await import("../../../packages/apps/dist/index.js");
const { e2bSandbox } = await import("../../../packages/apps/dist/e2b/index.js");
const { servedAppScaffold } = await import("../../../packages/apps/dist/scaffold/index.js");
const { guardFixture, memoryStore, scriptedLanguageModel } = await import(
  "../../../packages/apps/dist/testing/index.js"
);

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is required (source the shared keys first).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The scripted ladder: rung-1 tree, then REAL Node servers for rungs 2 and 3.
// ---------------------------------------------------------------------------

const keptTree = {
  formatVersion: "vendo-genui/v1",
  root: "root",
  nodes: [
    { id: "root", component: "Stack", source: "prewired", children: ["title", "subtitle", "divider", "detail"] },
    { id: "title", component: "Text", source: "prewired", props: { text: "Bakery cash dashboard" } },
    { id: "subtitle", component: "Text", source: "prewired", props: { text: "Same surface on every rung." } },
    { id: "divider", component: "Divider", source: "prewired" },
    { id: "detail", component: "Text", source: "prewired", props: { text: "Cash on hand: $4,180 · Weekly trend: up" } },
  ],
};

const fnServer = (marker) => `
const http = require("node:http");
http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let args;
    try { args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").args; } catch { args = undefined; }
    if (request.method === "POST" && request.url === "/fn/total") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ result: { total: Number(args?.a ?? 0) + Number(args?.b ?? 0), rung: "${marker}" } }));
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not-found", message: "no such fn" } }));
  });
}).listen(Number(process.env.PORT || 8080));
`;

const instructionOf = (text) => /INSTRUCTION:\s*(.*)/.exec(text)?.[1] ?? "";
const model = scriptedLanguageModel((call) => {
  const text = call.prompt
    .map((message) => typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.text ?? "").join(""))
    .join("\n");
  if (text.includes("TASK: CREATE_APP")) {
    return JSON.stringify({ name: "Bakery cash dashboard", description: "invisible graduation demo", tree: keptTree });
  }
  const instruction = instructionOf(text);
  if (instruction.includes("full web app")) {
    return JSON.stringify({ rung: 4, files: [{ path: "/app/custom.js", content: "exports.custom = 1;" }] });
  }
  if (instruction.includes("computed")) {
    return JSON.stringify({ rung: 3, files: [{ path: "/app/server.js", content: fnServer("three") }] });
  }
  return JSON.stringify({ rung: 2, files: [{ path: "/app/server.js", content: fnServer("two") }] });
});

const CLIMBS = [
  "Add a server backend to persist data",
  "Return a server-computed dashboard tree",
  "Turn this into a full web app",
];

// ---------------------------------------------------------------------------
// Real runtime on real E2B.
// ---------------------------------------------------------------------------

const runtime = createApps({
  store: memoryStore(),
  guard: guardFixture(),
  tools: {
    async descriptors() { return []; },
    async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
  },
  sandbox: e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 120_000 }),
  catalog: [],
  model,
});
const ada = { principal: { kind: "user", subject: "user_demo" }, venue: "app", presence: "present", sessionId: "session_demo" };

const app = await runtime.create({ prompt: "Show my bakery cash dashboard" }, ada);
let climbed = 0;

// ---------------------------------------------------------------------------
// Two local servers: the demo page, and a root-served scaffold preview whose
// bytes are exactly servedAppScaffold(current document) — the same renderer
// the graduated machine serves, so rungs 1–3 and rung 4 paint identically.
// ---------------------------------------------------------------------------

const listen = (server) => new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const currentDoc = async () => runtime.get(app.id, ada);

const previewServer = createServer(async (request, response) => {
  const doc = await currentDoc();
  const files = new Map(servedAppScaffold(doc).map((file) => [file.path.replace("/app", "") || "/", file.content]));
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const content = files.get(path === "/" ? "/index.html" : path);
  if (content === undefined) {
    response.writeHead(404, { "content-type": "application/json" });
    return response.end(JSON.stringify({ error: { code: "not-found", message: "route not found" } }));
  }
  const type = path.endsWith(".js") ? "text/javascript; charset=utf-8"
    : path.endsWith(".json") ? "application/json; charset=utf-8"
      : "text/html; charset=utf-8";
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  response.end(content);
});
const previewPort = await listen(previewServer);

const PAGE = (previewUrl) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Invisible graduation (ENG-290)</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f4f4f6; }
  #surface { width: 720px; height: 300px; margin: 24px auto 12px; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(20,20,30,.12); }
  #surface iframe { width: 100%; height: 100%; border: 0; display: block; }
  #status { width: 720px; margin: 0 auto 24px; padding: 12px 16px; background: #101018; color: #e8e8f0; border-radius: 10px; font: 13px/1.6 ui-monospace, monospace; }
  #status b { color: #7dd3a8; }
</style>
</head>
<body>
<div id="surface"><iframe id="frame" title="Vendo app" src="${previewUrl}"></iframe></div>
<div id="status">loading…</div>
<script>
  async function refresh() {
    const state = await (await fetch("/state")).json();
    document.getElementById("status").innerHTML =
      "rung <b>" + state.rung + "</b> · surface <b>" + state.surface + "</b>" +
      " · server <b>" + state.server + "</b> · fn:total(2,3) <b>" + state.fnTotal + "</b>";
    const frame = document.getElementById("frame");
    if (state.url && frame.dataset.live !== "yes") { frame.dataset.live = "yes"; frame.src = state.url; }
    document.body.dataset.rung = String(state.rung);
    document.body.dataset.ready = "yes";
  }
  refresh();
</script>
</body>
</html>`;

let lastVersionRung = 1;
const demoServer = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(PAGE(`http://127.0.0.1:${previewPort}/`));
    }
    if (path === "/state") {
      const doc = await currentDoc();
      const rung = doc.ui === "http" ? 4 : doc.server === undefined ? 1 : lastVersionRung;
      let fnTotal = "—";
      if (doc.server !== undefined && doc.ui !== "http") {
        const outcome = await runtime.call(app.id, "fn:total", { a: 2, b: 3 }, ada);
        fnTotal = outcome.status === "ok" ? String(outcome.output.total) : outcome.status;
      }
      let url;
      if (doc.ui === "http") {
        for (let attempt = 0; attempt < 60 && url === undefined; attempt += 1) {
          const surface = await runtime.open(app.id, ada);
          if (surface.kind === "http") url = surface.url;
          else await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        assert.ok(url, "rung-4 machine never started serving through open()");
      }
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({
        rung,
        surface: doc.ui === "http" ? "http (real E2B machine)" : "tree",
        server: doc.server === undefined ? "none" : `${doc.server.slice(0, 12)}…`,
        fnTotal,
        url,
      }));
    }
    if (path === "/climb" && request.method === "POST") {
      const instruction = CLIMBS[climbed];
      assert.ok(instruction, "no more rungs to climb");
      const result = await runtime.edit(app.id, instruction, ada);
      assert.equal(result.issues, undefined, `edit failed: ${result.issues?.join("; ")}`);
      climbed += 1;
      lastVersionRung = result.version.rung;
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify(result.version));
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not-found", message: "route not found" } }));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "demo", message: String(error?.message ?? error) } }));
  }
});
const demoPort = await listen(demoServer);

// ---------------------------------------------------------------------------
// Drive it in a real browser and capture the evidence.
// ---------------------------------------------------------------------------

const browser = await chromium.launch();
let failure;
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 420 } });
  page.on("pageerror", (error) => { failure ??= error; });

  const surfaces = [];
  const settle = async (expectedRung) => {
    await page.goto(`http://127.0.0.1:${demoPort}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(
      (rung) => document.body.dataset.ready === "yes" && document.body.dataset.rung === String(rung),
      expectedRung,
      { timeout: 120_000 },
    );
    // Let the framed renderer paint (it fetches tree.json + components.json).
    await page.waitForTimeout(1500);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    assert.ok(frame, "app surface iframe missing");
    await frame.waitForSelector('[data-vendo-node-id="title"]', { timeout: 60_000 });
    await page.screenshot({ path: join(evidenceDir, `rung-${expectedRung}.png`) });
    const surface = await page.locator("#surface").screenshot({
      path: join(evidenceDir, `surface-rung-${expectedRung}.png`),
    });
    surfaces.push(surface);
    const status = await page.locator("#status").innerText();
    console.log(`rung ${expectedRung}: ${status.replace(/\s+/g, " ")}`);
    return status;
  };

  const rung1 = await settle(1);
  assert.match(rung1, /server none/);

  for (const [index, expectedRung] of [2, 3, 4].entries()) {
    const climb = await page.request.post(`http://127.0.0.1:${demoPort}/climb`, { timeout: 180_000 });
    assert.equal(climb.status(), 200, await climb.text());
    const version = await climb.json();
    assert.equal(version.rung, expectedRung, `climb ${index + 1} landed on rung ${version.rung}`);
    const status = await settle(expectedRung);
    if (expectedRung < 4) {
      assert.match(status, /server e2b:v1:/, "machine ref must be a real opaque E2B snapshot ref");
      assert.match(status, /fn:total\(2,3\) 5/, "the real machine must answer fn:total");
    } else {
      assert.match(status, /http \(real E2B machine\)/);
    }
  }

  // The invisible part: rungs 1–3 paint the surface pixel-identically.
  assert.ok(surfaces[0].equals(surfaces[1]), "rung-2 surface changed visibly");
  assert.ok(surfaces[0].equals(surfaces[2]), "rung-3 surface changed visibly");
  // Rung 4 renders the same kept tree from the machine's own origin; prove the
  // text content and layout by DOM instead of bytes (cross-origin frame paint
  // timing can shift antialiasing).
  const served = page.frames().find((candidate) => candidate !== page.mainFrame());
  assert.ok(served, "rung-4 iframe missing");
  const title = await served.locator('[data-vendo-node-id="title"]').innerText();
  assert.equal(title, "Bakery cash dashboard");
  const detail = await served.locator('[data-vendo-node-id="detail"]').innerText();
  assert.ok(detail.includes("Cash on hand"), "served detail text missing");

  console.log("PASS: surface identical across rungs 1–3; rung 4 serves the identical kept tree from the real machine.");
} catch (error) {
  failure ??= error;
} finally {
  await browser.close();
  demoServer.close();
  previewServer.close();
  await runtime.delete(app.id, ada).catch(() => undefined);
}

if (failure) {
  console.error(failure);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GIF: the four full-page frames, ~1.4s each.
// ---------------------------------------------------------------------------
try {
  await promisify(execFile)("ffmpeg", [
    "-y",
    "-framerate", "0.7",
    // Frames are rung-1..4; pin start_number rather than relying on image2's
    // default 0..4 probe window (which does find rung-1, but implicitly).
    "-start_number", "1",
    "-i", join(evidenceDir, "rung-%d.png"),
    "-vf", "scale=780:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
    join(evidenceDir, "invisible-graduation.gif"),
  ]);
  console.log("wrote invisible-graduation.gif");
} catch (error) {
  console.error("GIF assembly failed (screenshots remain valid evidence):", error?.message ?? error);
  process.exit(1);
}
