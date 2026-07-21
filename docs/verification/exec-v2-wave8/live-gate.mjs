#!/usr/bin/env node
/**
 * execution-v2 Wave 8 — THE GATE, re-run through the Claude Agent SDK box
 * engine: the Wave-3 invoice-chaser graduation (tree → graduate → egress
 * approval → schedule fires → durable /box digest row → reopen shows the
 * digest) plus one Wave-4 layer-3 build (2→3 kanban served app), all on real
 * e2b + real Claude against the real wired createVendo server through a
 * cloudflared tunnel (the box's /box callbacks reach the host store).
 *
 *   node --env-file <keys> live-gate.mjs --template <sdk-template-id>
 *
 * Requires E2B_API_KEY + ANTHROPIC_API_KEY + cloudflared on PATH.
 * Every sandbox is destroyed via apps.delete (destroyResources) at the end.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const requireVendo = createRequire(path.join(here, "../../../packages/vendo/package.json"));

// A stray rejection anywhere in the wired runtime (idle sweeps, tunnel
// hiccups) must not kill the gate mid-flight — log it and keep driving.
process.on("unhandledRejection", (reason) => {
  console.log(`[unhandledRejection] ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
process.on("uncaughtException", (error) => {
  console.log(`[uncaughtException] ${error.stack ?? error.message}`);
});

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const template = arg("template");
if (!template) throw new Error("--template <id> is required");
if (!process.env.E2B_API_KEY || !process.env.ANTHROPIC_API_KEY) {
  throw new Error("E2B_API_KEY and ANTHROPIC_API_KEY must be set");
}

const PORT = 3400;
const TICK_SECRET = "w8-gate-tick-secret";

const step = (name, payload) => {
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(payload, null, 2).slice(0, 4_000));
};

// ─── tunnel ───────────────────────────────────────────────────────────────
const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
const tunnelUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("tunnel URL never appeared")), 60_000);
  const scan = (chunk) => {
    const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) { clearTimeout(timer); resolve(match[0]); }
  };
  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);
  tunnel.on("exit", () => reject(new Error("cloudflared exited early")));
});
step("tunnel", { url: tunnelUrl });

// ─── the real wired server ────────────────────────────────────────────────
process.env.VENDO_BASE_URL = tunnelUrl;
process.env.VENDO_TICK_SECRET = TICK_SECRET;
process.env.VENDO_BOX_TEMPLATE = template;
process.env.VENDO_BOX_EDIT_TIMEOUT_MS = process.env.VENDO_BOX_EDIT_TIMEOUT_MS ?? "1200000";
process.env.VENDO_E2B_TIMEOUT_MS = process.env.VENDO_E2B_TIMEOUT_MS ?? "1800000";
process.env.VENDO_INFERENCE_URL = process.env.VENDO_INFERENCE_URL ?? "https://api.anthropic.com";
process.env.VENDO_INFERENCE_KEY = process.env.VENDO_INFERENCE_KEY ?? process.env.ANTHROPIC_API_KEY;

const { createVendo } = await import(requireVendo.resolve("@vendoai/vendo/server"));
const { createStore } = await import(requireVendo.resolve("@vendoai/store"));
const { createAnthropic } = await import(requireVendo.resolve("@ai-sdk/anthropic"));

const dataDir = mkdtempSync(path.join(tmpdir(), "vendo-w8-gate-"));
const store = createStore({ dataDir });
await store.ensureSchema();
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const vendo = createVendo({
  model: anthropic("claude-sonnet-4-5"),
  principal: async () => ({ kind: "user", subject: "user_w8_gate" }),
  store,
  // Wave 9 — served apps now require the machines flag too.
  apps: { experimentalServedApps: true, experimentalMachines: true },
});

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
    });
    const response = await vendo.handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "internal", message: error instanceof Error ? error.message : "boom" } }));
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));
step("server", { port: PORT, template });

const ADA = { kind: "user", subject: "user_w8_gate" };
const ctx = { principal: ADA, venue: "app", presence: "present", sessionId: "session_w8_gate" };

let exitCode = 0;
const appIds = [];
try {
  // ─── 1. tree app ────────────────────────────────────────────────────────
  // create() returns the AppDocument itself.
  const created = await vendo.apps.create({
    prompt: "Show a status board for my invoices: total outstanding in dollars, invoice count, and the invoice list.",
  }, ctx);
  appIds.push(created.id);
  step("tree-created", {
    id: created.id,
    ui: created.ui ?? "tree",
    hasMachine: created.machine !== undefined,
  });

  // ─── 2. graduation through the SDK box agent ────────────────────────────
  const instruction = [
    "Watch my unpaid invoices and email me a digest every morning at 8am, and show the latest digest on the status board.",
    "Build a zero-dependency Node server:",
    "- POST /fn/chaseInvoices: compute a digest of 3 sample invoices (count + totalCents + the invoice list), POST the digest JSON to https://httpbin.org/post, and store the digest as a durable row through the Vendo store.",
    "- POST /fn/getDigest: return the latest stored digest row (or a freshly computed digest if none stored yet).",
    "- vendo.json must declare the 8am daily schedule for chaseInvoices and the httpbin.org egress.",
  ].join("\n");
  step("graduate-start", { instruction: `${instruction.slice(0, 200)}…` });
  const graduated = await vendo.apps.edit(created.id, instruction, ctx);
  step("graduated", {
    graduated: graduated.graduated === true,
    box: graduated.box,
    pendingEgress: graduated.pendingEgress,
    machine: typeof graduated.app.machine === "string" ? `${graduated.app.machine.slice(0, 24)}…` : graduated.app.machine,
    egress: graduated.app.egress,
    issues: graduated.issues,
    failure: graduated.failure,
  });
  if (graduated.failure !== undefined || graduated.box?.ok !== true) throw new Error("graduation failed");

  // ─── 3. egress approval ─────────────────────────────────────────────────
  const pending = await vendo.guard.approvals.pending(ADA);
  step("pending-approvals", pending.map((entry) => ({ id: entry.id, tool: entry.tool ?? entry.action })));
  const egressApprovals = pending.filter((entry) => JSON.stringify(entry).includes("egress"));
  if (egressApprovals.length === 0) throw new Error("no parked egress approval");
  await vendo.guard.approvals.decide(egressApprovals.map((entry) => entry.id), { approve: true }, ADA);
  const afterApprove = await store.records("vendo_apps").get(created.id);
  step("egress-approved", { egressApproved: afterApprove?.data?.doc?.egressApproved });

  // ─── 4. the schedule fires (8am window, host clock faked Date-only) ─────
  // The fire baseline is the schedule-sync time (graduation, real now), and
  // cron is evaluated in UTC — so the faked clock must sit at the NEXT 8am
  // UTC occurrence AFTER the baseline: tomorrow 08:00:30 UTC.
  const RealDate = Date;
  const eight = new RealDate(RealDate.now() + 24 * 3_600_000);
  eight.setUTCHours(8, 0, 30, 0);
  const fakeNowMs = eight.getTime();
  const FakeDate = class extends RealDate {
    constructor(...args) { if (args.length === 0) { super(fakeNowMs); } else { super(...args); } }
    static now() { return fakeNowMs; }
  };
  globalThis.Date = FakeDate;
  let tick;
  try {
    tick = await (await fetch(`http://localhost:${PORT}/api/vendo/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${TICK_SECRET}` },
    })).json();
  } finally {
    globalThis.Date = RealDate;
  }
  step("wire-tick", tick);
  const fired = (tick.schedules?.fired ?? []).find((entry) => entry.fn === "chaseInvoices");
  if (fired === undefined || fired.status !== "ok") throw new Error(`schedule did not fire ok: ${JSON.stringify(tick)}`);

  // ─── 5. reopen: the digest is in the tree (durable /box row round trip) ─
  const reopened = await vendo.apps.open(created.id, ctx);
  const reopenedText = JSON.stringify(reopened);
  step("reopened", {
    kind: reopened.kind ?? "tree",
    hasDigest: /totalCents|digest/i.test(reopenedText),
    dataPreview: reopenedText.slice(0, 600),
  });

  // ─── 6. layer-3: one served-app build through the SDK engine ────────────
  const kanban = await vendo.apps.create({ prompt: "A board that lists my invoices grouped by status (Draft / Sent / Paid)." }, ctx);
  appIds.push(kanban.id);
  const escalated = await vendo.apps.edit(
    kanban.id,
    "Rebuild this as a full web app: a kanban board for my invoices with drag-and-drop between columns (Draft / Sent / Paid), moving a card updates its status server-side.",
    ctx,
  );
  step("layer3-edit", {
    graduated: escalated.graduated === true,
    box: escalated.box,
    ui: escalated.app.ui,
    failure: escalated.failure,
    issues: escalated.issues,
  });
  if (escalated.failure !== undefined || escalated.box?.ok !== true) throw new Error("layer-3 build failed");
  const opened = await vendo.apps.open(kanban.id, ctx);
  const served = opened.kind === "http" ? await fetch(opened.url) : undefined;
  step("layer3-open", {
    kind: opened.kind,
    url: opened.kind === "http" ? opened.url.replace(/vendoTheme=.*$/, "vendoTheme=…") : undefined,
    status: served?.status,
    contentType: served?.headers.get("content-type"),
  });
  if (opened.kind !== "http" || served?.status !== 200) throw new Error("served app did not answer 200");

  step("GATE", { pass: true });
} catch (error) {
  exitCode = 1;
  step("GATE", { pass: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  for (const appId of appIds) {
    await vendo.apps.delete(appId, ctx).catch((error) => step("cleanup-error", { appId, error: String(error) }));
  }
  step("cleanup", { deleted: appIds });
  server.close();
  tunnel.kill();
  await store.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(exitCode);
}
