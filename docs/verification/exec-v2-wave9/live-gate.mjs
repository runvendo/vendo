// execution-v2 Wave 9 live gate — the escalation ladder's rung (a) with a REAL
// model: "email me a digest of unpaid invoices at 8am" must become a working
// STEPS automation in seconds (setup timed), fire through the EXISTING
// automations tick, and land its result in a store row the tree's query
// shows — with NO machine anywhere (no sandbox adapter is even composed).
//
// Run:  node docs/verification/exec-v2-wave9/live-gate.mjs
// Keys: ANTHROPIC_API_KEY from /Users/yousefh/orca/workspaces/flowlet/.env
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const requireVendo = createRequire(path.join(here, "../../../packages/vendo/package.json"));

const die = (message) => {
  console.error(`GATE FAIL: ${message}`);
  process.exit(1);
};

if (!process.env.ANTHROPIC_API_KEY) die("ANTHROPIC_API_KEY not set");

const { createApps } = await import(requireVendo.resolve("@vendoai/apps"));
const { createAutomations } = await import(requireVendo.resolve("@vendoai/automations"));
const { createGuard } = await import(requireVendo.resolve("@vendoai/guard"));
const { createStore } = await import(requireVendo.resolve("@vendoai/store"));
const { createAnthropic } = await import(requireVendo.resolve("@ai-sdk/anthropic"));

// ── An invoice-shaped host (the canonical case): one read tool with real
//    rows, one write email tool with an observable side effect ─────────────
const emails = [];
const invoices = [
  { id: "inv_1041", client: "Acme Robotics", amountCents: 420000, dueDate: "2026-07-10", status: "unpaid" },
  { id: "inv_1042", client: "Birchwood LLC", amountCents: 155000, dueDate: "2026-07-15", status: "unpaid" },
];
const hostTools = {
  async descriptors() {
    return [
      {
        name: "host_listUnpaidInvoices",
        description: "List the unpaid invoices (id, client, amountCents, dueDate).",
        inputSchema: { type: "object", properties: {} },
        risk: "read",
      },
      {
        name: "host_sendEmail",
        description: "Send the signed-in user an email.",
        inputSchema: {
          type: "object",
          properties: { subject: { type: "string" }, body: { type: "string" } },
          required: ["subject", "body"],
        },
        risk: "write",
      },
    ];
  },
  async execute(call) {
    if (call.tool === "host_listUnpaidInvoices") {
      return { status: "ok", output: { invoices, count: invoices.length } };
    }
    if (call.tool === "host_sendEmail") {
      emails.push(call.args);
      return { status: "ok", output: { sent: true } };
    }
    return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
  },
};

const dataDir = mkdtempSync(path.join(tmpdir(), "vendo-w9-gate-"));
const store = createStore({ dataDir });
await store.ensureSchema();
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const principal = { kind: "user", subject: "user_w9_gate" };
// Blocks composed exactly the way the umbrella composes them (demo-bank's
// policy: reads run, writes ask), including the Wave-9 arming seam: the
// automations engine enables a ladder-authored automation (grant capture).
const guard = createGuard({
  store,
  policy: {
    rules: [
      { match: { risk: "destructive" }, action: "ask" },
      { match: { risk: "write" }, action: "ask" },
      { match: { risk: "read" }, action: "run" },
    ],
  },
});
let appsToolsRef;
const combined = {
  async descriptors() {
    return [
      ...await hostTools.descriptors(),
      ...(appsToolsRef === undefined ? [] : await appsToolsRef.descriptors()),
    ];
  },
  async execute(call, callCtx) {
    const hostNames = new Set((await hostTools.descriptors()).map((tool) => tool.name));
    if (hostNames.has(call.tool)) return hostTools.execute(call, callCtx);
    if (appsToolsRef !== undefined) return appsToolsRef.execute(call, callCtx);
    return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
  },
};
const boundTools = guard.bind(combined);
let automationsRef;
const apps = createApps({
  store,
  guard,
  tools: boundTools,
  catalog: [],
  model: anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6"),
  armAutomation: async (appId, armCtx) => automationsRef.enable(appId, armCtx),
  // NO sandbox adapter, NO experimentalMachines: rung (a) needs neither.
});
appsToolsRef = apps.agentTools();
const automations = createAutomations({ apps, tools: boundTools, guard, store });
automationsRef = automations;
const vendo = { apps, automations, guard };

const ctx = { principal, venue: "chat", presence: "present", sessionId: "session_w9_gate" };

// Seed a plain tree app (the pre-existing invoice board the user asks about).
const seeded = await vendo.apps.importApp({
  format: "vendo/app@1",
  id: "app_seed",
  name: "Invoice board",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["title"] },
      { id: "title", component: "Text", source: "prewired", props: { text: "Invoices" } },
    ],
  },
}, ctx);

// ── 1. The canonical prompt becomes a STEPS automation — TIMED ────────────
const startedAt = Date.now();
const result = await vendo.apps.edit(seeded.id, "email me a digest of unpaid invoices at 8am", ctx);
const setupSeconds = (Date.now() - startedAt) / 1000;
if (result.failure !== undefined) die(`edit failed: ${JSON.stringify(result.issues)}`);
if (result.automation?.mode !== "steps") die(`expected a steps automation, got ${JSON.stringify(result.automation ?? result)}`);
if (result.app.machine !== undefined) die("a machine appeared on the document");
console.log(`automation authored+armed in ${setupSeconds.toFixed(1)}s`);
console.log(`trigger: ${JSON.stringify(result.app.trigger, null, 2)}`);
console.log(`resultsCollection: ${result.automation.resultsCollection}`);

// ── 2. Approve the captured standing grants (the dock's approval cards) ───
const pending = result.automation.pendingGrants ?? [];
console.log(`pending standing-grant approvals: ${pending.map((request) => request.call.tool).join(", ") || "(none)"}`);
for (const request of pending) {
  await vendo.guard.approvals.decide(request.id, { approve: true }, principal);
}

// ── 3. The EXISTING trigger machinery fires it (synthetic clock: the next
//       8am UTC after the arming tick) ────────────────────────────────────
const seedTick = await vendo.automations.tick(new Date());
if (seedTick.length !== 0) console.log(`note: seed tick fired ${seedTick.length} run(s) early`);
const next8am = new Date();
next8am.setUTCDate(next8am.getUTCDate() + 1);
next8am.setUTCHours(8, 0, 5, 0);
const runIds = await vendo.automations.tick(next8am);
if (runIds.length !== 1) die(`expected 1 fired run at synthetic 8am, got ${runIds.length}`);
const run = await vendo.automations.runs.get(runIds[0], ctx);
if (run?.status !== "ok") die(`run status ${run?.status}: ${JSON.stringify(run?.error ?? run?.steps)}`);
console.log(`run ${run.id} ok: ${run.steps.map((step) => `${step.tool}=${step.outcome}`).join(", ")}`);
console.log(`emails sent by the automation: ${JSON.stringify(emails)}`);

// ── 4. The result is visible in the tree (open() resolves the query) ──────
const surface = await vendo.apps.open(seeded.id, ctx);
if (surface.kind !== "tree") die(`expected the tree surface, got ${surface.kind}`);
const payload = JSON.stringify(surface.payload);
const collection = result.automation.resultsCollection;
const row = collection === undefined
  ? null
  : await store.records(`app:${seeded.id}:${collection}`).get("latest").catch(() => null);
if (row === null) die("no results row landed in the app data collection");
const rowJson = JSON.stringify(row.data);
console.log(`results row: ${rowJson.slice(0, 400)}`);
// Data honesty: the digest must carry the HOST tool's real rows, not
// hand-typed content.
if (!rowJson.includes("Acme Robotics") && !rowJson.includes("inv_1041")) {
  die("the published digest does not carry the host tool's real invoice data");
}
const visible = payload.includes("Acme Robotics") || payload.includes("inv_1041");
if (!visible) {
  console.log(`tree payload (for inspection): ${payload.slice(0, 2000)}`);
  die("the digest result is not visible in the opened tree payload");
}
if (emails.length === 0) die("the 'email me' effect never fired (host_sendEmail was available)");
// The email must carry the real digest, not an empty or unrelated body.
if (!emails.some((email) => JSON.stringify(email).includes("Acme Robotics"))) {
  die("the sent email does not carry the host tool's real invoice data");
}

// ── 5. ZERO sandbox creation ───────────────────────────────────────────────
const after = await vendo.apps.get(seeded.id, ctx);
if (after?.machine !== undefined) die("machine present after the run");
console.log("no machine anywhere: PASS");
console.log(`GATE PASS — setup ${setupSeconds.toFixed(1)}s, fired via tick, result visible in tree, zero sandboxes`);
await store.close();
rmSync(dataDir, { recursive: true, force: true });
