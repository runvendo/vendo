#!/usr/bin/env node
/**
 * THE LIVE PROOF for the conversational box's egress allowlist.
 *
 * Before this fix `claudeCode()` created its box with no `allowedDomains`, which
 * the seam reads as UNRESTRICTED internet — so a prompt-injected message could
 * `curl` the workspace to anywhere, with no guard and no audit row (the guard
 * only ever sees `mcp__vendo__*`, never the box's own shell). This proves the
 * hole is closed AND that closing it did not break the box.
 *
 * Nothing here is a double: a real e2b machine, the real box image, a real Agent
 * SDK session inside it, a real host over a real public URL, a real MCP door.
 *
 *   cloudflared tunnel --url http://localhost:8790 --no-autoupdate
 *   PROOF_PUBLIC_URL=https://<name>.trycloudflare.com \
 *     node docs/verification/box-egress/live-egress-proof.mjs
 *
 * Needs E2B_API_KEY, ANTHROPIC_API_KEY, VENDO_BOX_TEMPLATE.
 *
 * What it checks, in order:
 *   A. NETWORK — a box booted with the REAL allowlist reaches the inference host
 *      and CANNOT reach an unlisted domain (deterministic, via the adapter's
 *      private exec; no model involved)
 *   B. the allowlist the harness actually hands the provider is the minimum set
 *   1. inference FROM INSIDE the box still works with the allowlist on
 *   2. a tool call still travels the door, and lands one audit row
 *   3. an app the box authors still lands in the host's workspace
 */

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const fromUmbrella = createRequire(new URL("../../../packages/vendo/package.json", import.meta.url));
const load = async (specifier) => import(pathToFileURL(fromUmbrella.resolve(specifier)).href);

const need = ["E2B_API_KEY", "ANTHROPIC_API_KEY", "VENDO_BOX_TEMPLATE"];
for (const key of need) {
  if (!process.env[key]) {
    console.error(`[proof] missing ${key}`);
    process.exit(2);
  }
}

const { createVendo } = await load("@vendoai/vendo/server");
const { createStore } = await load("@vendoai/store");
const { claudeCode, boxEgress, inferenceEnv } = await load("@vendoai/harnesses/claude-code");
const { e2bSandbox } = await load("@vendoai/apps/e2b");

const SUBJECT = "user_live_egress";
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} · ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

const PORT = Number(process.env.PROOF_PORT ?? 8790);
const publicUrl = process.env.PROOF_PUBLIC_URL;
if (publicUrl === undefined) {
  console.error(`[proof] set PROOF_PUBLIC_URL to a tunnel pointing at localhost:${PORT}`);
  process.exit(2);
}
console.log(`[proof] public origin: ${publicUrl}`);

const DOOR_URL = new URL("/api/vendo/mcp", publicUrl).toString();
const DOOR_HOST = new URL(publicUrl).hostname;
/** Deliberately NOT in any allowlist this proof builds. */
const UNLISTED = "example.com";

// ── A · the network policy itself, with no model in the way ───────────────────
const adapterFor = () => e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 8 * 60_000 });

const probeNetwork = async () => {
  const allowlist = boxEgress(inferenceEnv(), DOOR_URL);
  console.log(`[proof] allowlist under test: ${JSON.stringify(allowlist)}`);
  const machine = await adapterFor().create({
    template: process.env.VENDO_BOX_TEMPLATE,
    env: { ...inferenceEnv(), VENDO_WORKSPACE_ROOT: "/workspace" },
    allowedDomains: allowlist,
  });
  // The adapter-private bootstrap surface, exactly as the Lane E live gate uses it.
  const box = machine;
  const curl = async (host) => {
    const result = await box.exec(
      `curl -sS -o /dev/null -m 12 -w '%{http_code}' https://${host}/ 2>&1 || echo BLOCKED`,
      { timeoutMs: 40_000 },
    );
    return `${result.stdout}${result.stderr}`.trim();
  };
  try {
    const inference = await curl(allowlist[0]);
    const unlisted = await curl(UNLISTED);
    const door = await curl(DOOR_HOST);
    return { allowlist, inference, unlisted, door };
  } finally {
    await box.destroy().catch(() => undefined);
  }
};

// ── the host ──────────────────────────────────────────────────────────────────
const dataDir = await mkdtemp(join(tmpdir(), "vendo-live-egress-"));
const store = createStore({ dataDir });

const toolCalls = [];
const hostTools = {
  async descriptors() {
    return [{
      name: "maple_invoices_list",
      title: "List invoices",
      description: "List the signed-in customer's outstanding invoices.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    }];
  },
  async execute(call) {
    toolCalls.push({ tool: call.tool, args: call.args });
    return { status: "ok", output: { invoices: [{ id: "inv_9042", amount: 1180 }] } };
  },
};

/** The create SPEC the harness hands the provider — the only place the network
 *  policy is observable, so the real adapter is wrapped rather than replaced. */
const createSpecs = [];
const watchedSandbox = () => {
  const inner = adapterFor();
  return {
    ...inner,
    async create(spec) {
      createSpecs.push({ template: spec.template, allowedDomains: spec.allowedDomains });
      return inner.create(spec);
    },
  };
};

const vendo = createVendo({
  model: {},
  principal: async () => ({ kind: "user", subject: SUBJECT }),
  store,
  policy: "cautious",
  harness: claudeCode({ sandbox: watchedSandbox() }),
  mcp: { baseUrl: publicUrl },
  oauth: {
    async authorize() { return { subject: SUBJECT }; },
    async principal(subject) { return { kind: "user", subject }; },
  },
});
vendo.actions.add(hostTools);
await store.ensureSchema();

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`${publicUrl}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]),
    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  });
  const answer = await vendo.handler(request);
  res.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
  res.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`[proof] host listening on :${PORT}`);

{
  // cloudflared prints its hostname before the edge has it in DNS.
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const probe = await fetch(DOOR_URL, { method: "GET" });
      ready = probe.status > 0;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (!ready) {
    console.error("[proof] the tunnel never became reachable");
    process.exit(2);
  }
  console.log("[proof] tunnel is reachable from the public internet");
}

const api = (path) => `${publicUrl}/api/vendo${path}`;
async function runTurn(threadId, text) {
  const response = await fetch(api("/threads"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      message: { id: `m_${threadId}_${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
    }),
  });
  if (!response.ok) throw new Error(`turn failed ${response.status}: ${await response.text()}`);
  return response.text();
}
const auditRows = async () => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: SUBJECT } });
  return records.map((row) => row.data);
};

let failed = false;
try {
  // ── A ───────────────────────────────────────────────────────────────────────
  console.log("\n[proof] A · the network policy, measured on a real box with no model in the way");
  const net = await probeNetwork();
  console.log(`[proof] curl results: ${JSON.stringify(net)}`);
  record(
    `A · the inference host (${net.allowlist[0]}) is reachable from inside the box`,
    /^\d{3}$/.test(net.inference) && net.inference !== "000",
    `curl → ${net.inference}`,
  );
  record(
    `A · the door origin is reachable from inside the box`,
    /^\d{3}$/.test(net.door) && net.door !== "000",
    `curl → ${net.door}`,
  );
  record(
    `A · an ordinary client (curl) cannot reach an UNLISTED domain (${UNLISTED})`,
    !/^[1-5]\d\d$/.test(net.unlisted),
    `curl → ${JSON.stringify(net.unlisted)}`,
  );

  // ── 1 + 2 · the box still thinks, and still reaches the door ────────────────
  console.log("\n[proof] 1+2/3 · inference inside the box, and a tool call through the door");
  const readStream = await runTurn(
    "thr_egress_read",
    "How many invoices are outstanding, and what is the id? Answer in one short sentence.",
  );
  record(
    "B · the harness handed the provider the MINIMUM allowlist, never undefined",
    createSpecs.length > 0
      && Array.isArray(createSpecs[0].allowedDomains)
      && createSpecs[0].allowedDomains.includes(DOOR_HOST)
      && !createSpecs[0].allowedDomains.includes(UNLISTED),
    JSON.stringify(createSpecs[0]?.allowedDomains),
  );
  record(
    "1 · the model thought inside the box — it answered at all, with the allowlist on",
    readStream.length > 0 && readStream.includes("data: "),
    `stream bytes: ${readStream.length}`,
  );
  const rows = await auditRows();
  const readRow = rows.find((row) => row.kind === "tool-call" && row.tool === "maple_invoices_list");
  record(
    "2 · the box's tool call reached the host through the door",
    toolCalls.some((call) => call.tool === "maple_invoices_list"),
    `host executions: ${JSON.stringify(toolCalls.map((call) => call.tool))}`,
  );
  record(
    "2 · one audit row, carrying the TURN's venue and presence",
    readRow?.venue === "chat" && readRow?.presence === "present" && readRow?.outcome === "ok",
    JSON.stringify({ venue: readRow?.venue, presence: readRow?.presence, outcome: readRow?.outcome }),
  );
  record(
    "2 · the model answered with the HOST's data",
    readStream.includes("9042"),
    `stream mentions inv_9042: ${readStream.includes("9042")}`,
  );

  // ── 3 · an app the box builds still lands ───────────────────────────────────
  console.log("\n[proof] 3/3 · the box authors an app, and it lands in the host's workspace");
  await runTurn(
    "thr_egress_build",
    "Create an app file at user/apps/app_egress/app.vendo containing exactly:\n"
    + '<App name="Egress">\n  <Heading text="EGRESS-OK" />\n</App>\nThen say DONE.',
  );
  const workspace = await vendo.harness.workspace({ kind: "user", subject: SUBJECT });
  let landed = "";
  try {
    landed = await workspace.readFile("/user/apps/app_egress/app.vendo");
  } catch (error) {
    landed = `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
  record(
    "3 · the app the box built is readable through the host's workspace door",
    landed.includes("EGRESS-OK"),
    JSON.stringify(landed.slice(0, 160)),
  );
} catch (error) {
  failed = true;
  console.error("[proof] threw:", error);
} finally {
  const passed = results.filter((entry) => entry.pass).length;
  console.log(`\n[proof] ${passed}/${results.length} checks passed`);
  await writeFile(
    new URL("live-egress-proof.json", import.meta.url),
    `${JSON.stringify({
      at: new Date().toISOString(),
      publicUrl,
      template: process.env.VENDO_BOX_TEMPLATE,
      allowlistHandedToProvider: createSpecs.map((spec) => spec.allowedDomains),
      results,
    }, null, 2)}\n`,
  );
  server.closeAllConnections?.();
  server.close();
  await store.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(failed || passed !== results.length ? 1 : 0);
}
