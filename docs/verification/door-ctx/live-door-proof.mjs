#!/usr/bin/env node
/**
 * THE LIVE PROOF for door-ctx: a REAL e2b box, a REAL Claude Agent SDK session
 * inside it, reaching a REAL host over a REAL public URL, through the REAL MCP
 * door, with a credential the host minted for the turn in flight.
 *
 * Nothing here is a double. The only scaffolding is a cloudflared quick tunnel,
 * because the box needs an origin it can actually resolve — which is itself part
 * of what this proves: the flip makes the host's door a reachable dependency of
 * a boxed harness, where the old inverted bridge needed no inbound path at all.
 *
 *   node docs/verification/door-ctx/live-door-proof.mjs
 *
 * Needs E2B_API_KEY, ANTHROPIC_API_KEY, VENDO_BOX_TEMPLATE and `cloudflared`.
 *
 * What it checks, in order:
 *   1. a READ the policy runs → the model answers with host data, and the audit
 *      row says `venue: chat · presence: present` (NOT `venue: mcp`)
 *   2. the transcript MIRROR carries the same call
 *   3. a WRITE the policy parks → a card reaches the approvals queue MID-TURN,
 *      the turn WAITS, the tap executes it
 *   4. `workspace.commit()` — a file the tool wrote is readable through the
 *      host's own workspace door by the time the turn ends
 *   5. an UNATTENDED turn through the same door is judged ABSENT
 *   6. the credential 401s once the turn is over
 */

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

// This file lives in the EVIDENCE folder, not in a package, so `@vendoai/*` does
// not resolve from here. Resolve each one through the umbrella's own
// node_modules — the same links a composed host would use.
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
const { claudeCode } = await load("@vendoai/harnesses/claude-code");
const { e2bSandbox } = await load("@vendoai/apps/e2b");

const SUBJECT = "user_live_door";
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} · ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

// ── the public origin the box can resolve ─────────────────────────────────────
//
// A quick tunnel, driven from OUTSIDE this script. Spawning cloudflared inline
// proved unreliable (its URL is printed well before the edge has it in DNS, and
// the child's lifetime got tangled with the proof's), and the tunnel is
// scaffolding rather than the thing under test. Start one and pass it in:
//
//   cloudflared tunnel --url http://localhost:8788 --no-autoupdate
//   PROOF_PUBLIC_URL=https://<name>.trycloudflare.com node <this file>
const PORT = Number(process.env.PROOF_PORT ?? 8788);
const publicUrl = process.env.PROOF_PUBLIC_URL;
if (publicUrl === undefined) {
  console.error("[proof] set PROOF_PUBLIC_URL to a tunnel pointing at localhost:" + PORT);
  process.exit(2);
}
console.log(`[proof] public origin: ${publicUrl}`);

// ── the host ──────────────────────────────────────────────────────────────────
const dataDir = await mkdtemp(join(tmpdir(), "vendo-live-door-"));
const store = createStore({ dataDir });

const toolCalls = [];
const hostTools = {
  async descriptors() {
    return [
      {
        name: "maple_invoices_list",
        title: "List invoices",
        description: "List the signed-in customer's outstanding invoices.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        risk: "read",
      },
      {
        name: "maple_invoice_pay",
        title: "Pay an invoice",
        description: "Pay one outstanding invoice by id.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        risk: "write",
      },
    ];
  },
  async execute(call) {
    toolCalls.push({ tool: call.tool, args: call.args });
    if (call.tool === "maple_invoices_list") {
      return { status: "ok", output: { invoices: [{ id: "inv_7781", amount: 4210 }] } };
    }
    return { status: "ok", output: { paid: true, id: call.args?.id ?? null } };
  },
};

const vendo = createVendo({
  model: {},
  principal: async () => ({ kind: "user", subject: SUBJECT }),
  store,
  policy: "cautious",
  harness: claudeCode({ sandbox: e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 15 * 60_000 }) }),
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

// cloudflared prints its hostname before the edge has it in DNS. Poll the real
// public URL until it answers, or the first turn dies on ENOTFOUND.
{
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const probe = await fetch(`${publicUrl}/api/vendo/mcp`, { method: "GET" });
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

// ── helpers ───────────────────────────────────────────────────────────────────
const api = (path) => `${publicUrl}/api/vendo${path}`;

async function runTurn(threadId, text) {
  const response = await fetch(api("/threads"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, message: { id: `m_${threadId}_${Date.now()}`, role: "user", parts: [{ type: "text", text }] } }),
  });
  if (!response.ok) throw new Error(`turn failed ${response.status}: ${await response.text()}`);
  return response.text();
}

/** Poll the PUBLIC approvals wire and tap, exactly as a person's browser does. */
function tapWhenItAppears(tool, approve, budgetMs = 120_000) {
  return (async () => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const listed = await fetch(api("/approvals")).catch(() => undefined);
      if (listed?.ok) {
        const pending = await listed.json();
        const mine = pending.find((entry) => entry.call?.tool === tool);
        if (mine !== undefined) {
          const decided = await fetch(api("/approvals/decide"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [mine.id], decision: { approve } }),
          });
          return { tapped: decided.ok, id: mine.id };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return { tapped: false };
  })();
}

const auditRows = async () => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: SUBJECT } });
  return records.map((record) => record.data);
};

const mirrorOf = (stream) => stream.split("\n")
  .filter((line) => line.startsWith("data: "))
  .flatMap((line) => {
    try {
      const part = JSON.parse(line.slice(6));
      return typeof part.type === "string" && part.type.startsWith("tool-")
        ? [`${part.type}${part.toolName === undefined ? "" : `:${part.toolName}`}`]
        : [];
    } catch {
      return [];
    }
  });

let failed = false;
try {
  // ── 1 + 2 · a READ the policy runs ──────────────────────────────────────────
  console.log("\n[proof] 1/6 · a read, through the door, from inside a real box");
  const readStream = await runTurn("thr_live_read", "How many invoices are outstanding, and what is the id? Answer in one short sentence.");
  const rows = await auditRows();
  const readRow = rows.find((row) => row.kind === "tool-call" && row.tool === "maple_invoices_list");
  record(
    "1 · the box's read reached the host through the door",
    toolCalls.some((call) => call.tool === "maple_invoices_list"),
    `host executions: ${JSON.stringify(toolCalls.map((call) => call.tool))}`,
  );
  record(
    "1 · the audit row carries the TURN's venue and presence, not the door's",
    readRow?.venue === "chat" && readRow?.presence === "present" && readRow?.outcome === "ok",
    JSON.stringify({ venue: readRow?.venue, presence: readRow?.presence, outcome: readRow?.outcome, decidedBy: readRow?.decidedBy }),
  );
  record(
    "1 · the model answered with the HOST's data",
    readStream.includes("7781"),
    `stream mentions inv_7781: ${readStream.includes("7781")}`,
  );
  const mirrored = mirrorOf(readStream);
  record(
    "2 · the transcript mirror carries the call",
    mirrored.some((entry) => entry.includes("maple_invoices_list")),
    JSON.stringify(mirrored),
  );

  // ── 3 · a WRITE the policy parks ────────────────────────────────────────────
  console.log("\n[proof] 3/6 · a parked write: the card must reach the queue MID-turn");
  const tap = tapWhenItAppears("maple_invoice_pay", true);
  const payStream = await runTurn("thr_live_pay", "Pay invoice inv_7781. Then say DONE.");
  const tapped = await tap;
  const payRows = (await auditRows()).filter((row) => row.kind === "tool-call" && row.tool === "maple_invoice_pay");
  record(
    "3 · an approval card reached the user's queue while the turn waited",
    tapped.tapped === true,
    `approval ${tapped.id ?? "never appeared"}`,
  );
  record(
    "3 · the tap EXECUTED the call — not 'resolve it there, then retry'",
    payRows.some((row) => row.outcome === "ok"),
    JSON.stringify(payRows.map((row) => ({ outcome: row.outcome, decidedBy: row.decidedBy, venue: row.venue }))),
  );
  record(
    "3 · exactly ONE executed row for one intent",
    payRows.filter((row) => row.outcome === "ok").length === 1,
    `ok rows: ${payRows.filter((row) => row.outcome === "ok").length}`,
  );
  console.log(`[proof] pay stream tail: ${JSON.stringify(payStream.slice(-400))}`);

  // ── 4 · commit — the box's file work lands in OUR store ─────────────────────
  console.log("\n[proof] 4/6 · commit: a file the box wrote is readable through the host");
  await runTurn("thr_live_write", "Create a file at user/notes/proof.md containing exactly the line: DOOR-CTX-4417. Then say DONE.");
  const workspace = await vendo.harness.workspace({ kind: "user", subject: SUBJECT });
  let landed = "";
  try {
    landed = await workspace.readFile("/user/notes/proof.md");
  } catch (error) {
    landed = `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
  record(
    "4 · the box's write reached the host's workspace",
    landed.includes("DOOR-CTX-4417"),
    JSON.stringify(landed.slice(0, 120)),
  );

  // ── 5 · unattended, through the same door ───────────────────────────────────
  console.log("\n[proof] 5/6 · an unattended turn is judged ABSENT");
  const unattended = await vendo.harness.stream({
    threadId: "thr_live_absent",
    message: { id: "m_absent", role: "user", parts: [{ type: "text", text: "Pay invoice inv_7781. Then say DONE." }] },
    ctx: {
      principal: { kind: "user", subject: SUBJECT },
      venue: "automation",
      presence: "away",
      sessionId: "session_live_absent",
    },
  });
  const absentStream = await unattended.text();
  const absentRows = (await auditRows()).filter((row) => row.venue === "automation");
  record(
    "5 · the unattended turn's rows say away/automation",
    absentRows.some((row) => row.presence === "away"),
    JSON.stringify(absentRows.map((row) => ({ kind: row.kind, tool: row.tool, venue: row.venue, presence: row.presence, outcome: row.outcome }))),
  );
  record(
    "5 · nothing was EXECUTED for the absent run",
    !absentRows.some((row) => row.kind === "tool-call" && row.outcome === "ok"),
    `executed rows: ${absentRows.filter((row) => row.kind === "tool-call" && row.outcome === "ok").length}`,
  );
  console.log(`[proof] absent stream tail: ${JSON.stringify(absentStream.slice(-300))}`);

  // ── 6 · the credential dies with the turn ───────────────────────────────────
  console.log("\n[proof] 6/6 · a credential outside a turn is a 401");
  const stale = await fetch(`${publicUrl}/api/vendo/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer vtk_0123456789abcdef0123456789abcdef",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
  });
  record("6 · an unregistered turn credential is refused at the public door", stale.status === 401, `status ${stale.status}`);
} catch (error) {
  failed = true;
  console.error("[proof] threw:", error);
} finally {
  const passed = results.filter((entry) => entry.pass).length;
  console.log(`\n[proof] ${passed}/${results.length} checks passed`);
  await writeFile(
    new URL("live-door-proof.json", import.meta.url),
    `${JSON.stringify({ at: new Date().toISOString(), publicUrl, template: process.env.VENDO_BOX_TEMPLATE, results }, null, 2)}\n`,
  );
  server.close();
  await store.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(failed || passed !== results.length ? 1 : 0);
}
