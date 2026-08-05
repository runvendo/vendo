#!/usr/bin/env node
// TEST SCAFFOLDING ONLY — the BYO acceptance leg over a cloudflared quick tunnel (approved for exactly this, 2026-08-05). Never product; never imported from packages/**.
/**
 * Acceptance, BYO leg (spec §acceptance (2)): Anthropic key + e2b key + built
 * template + own Postgres — identical flow, ZERO Vendo services.
 *
 * Five things, same as the Cloud leg:
 *   1. a box boots           — the provider machine id, captured off the adapter
 *   2. the model thinks      — a real answer that needed host data
 *   3. workspace in Postgres — rows land in the CALLER's own database
 *   4. a guarded call parks  — a REAL approval mid-turn: parked, then resumed
 *   5. files persist         — two separate sessions, one file, second reads it
 *
 *   BYO_PG_URL=postgres://… PROOF_PUBLIC_URL=https://….trycloudflare.com \
 *   VENDO_BOX_TEMPLATE=<built id> node byo-live-accept.mjs
 *
 * Needs ANTHROPIC_API_KEY + E2B_API_KEY. The standalone `agent()` API only —
 * no createVendo, no Cloud key, no Vendo endpoint anywhere in this file.
 */
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import process from "node:process";

const dist = (file) => pathToFileURL(new URL(`../../../packages/agents/dist/${file}`, import.meta.url).pathname).href;
const { agent, postgres, e2b, tool, DOOR_PATH } = await import(dist("index.js"));
const { claudeCode } = await import(dist("harnesses.js"));

for (const key of ["ANTHROPIC_API_KEY", "E2B_API_KEY", "BYO_PG_URL", "PROOF_PUBLIC_URL", "VENDO_BOX_TEMPLATE"]) {
  if (!process.env[key]) {
    console.error(`[byo] missing ${key}`);
    process.exit(2);
  }
}
if (process.env.VENDO_API_KEY) {
  console.error("[byo] VENDO_API_KEY is set — this leg must run with zero Vendo services. Unset it.");
  process.exit(2);
}

const PORT = Number(process.env.PROOF_PORT ?? 8788);
const publicUrl = process.env.PROOF_PUBLIC_URL;
const MODEL = process.env.VENDO_LIVE_MODEL ?? "claude-sonnet-4-5";
const SUBJECT = process.env.BYO_SUBJECT ?? "user_byo_p10";
const NONCE = process.env.BYO_NONCE ?? "BYO-P10-4417";

// The model's words, joined from the stream's text-deltas. Asserting on the raw
// SSE bytes instead fails whenever the provider splits an answer mid-token
// ("B" + "YO-P10-4417"), which the first run of this leg proved it does.
const textOf = (raw) => raw.split("\n").filter((line) => line.startsWith("data: ")).flatMap((line) => {
  try {
    const part = JSON.parse(line.slice(6));
    return part.type === "text-delta" ? [part.delta] : [];
  } catch {
    return [];
  }
}).join("");

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} · ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

// ── the caller's own pieces: their Postgres, their e2b, their tools ──────────
const store = postgres(process.env.BYO_PG_URL);

const bootedBoxes = [];
const base = e2b({ apiKey: process.env.E2B_API_KEY, template: process.env.VENDO_BOX_TEMPLATE, timeoutMs: 15 * 60_000 });
const sandbox = {
  ...base,
  create: async (spec) => {
    const machine = await base.create(spec);
    bootedBoxes.push(machine.id);
    console.log(`[byo] box booted: ${machine.id}`);
    return machine;
  },
};

const hostExecutions = [];
const tools = [
  tool({
    name: "maple_invoices_list",
    description: "List the signed-in customer's outstanding invoices.",
    risk: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute() {
      hostExecutions.push("maple_invoices_list");
      return { invoices: [{ id: "inv_7781", amount: 4210 }] };
    },
  }),
  tool({
    // No risk label on purpose: ungraded asks at call time, which is the REAL
    // approval this leg must prove — parked mid-turn, then resumed by a tap.
    name: "maple_invoice_pay",
    description: "Pay one outstanding invoice by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    execute(input) {
      hostExecutions.push("maple_invoice_pay");
      return { paid: true, id: input.id ?? null };
    },
  }),
];

const byo = agent({
  name: "byo-accept",
  harness: claudeCode({ model: MODEL, template: process.env.VENDO_BOX_TEMPLATE, maxTurns: 14 }),
  store,
  sandbox,
  door: { baseUrl: publicUrl },
  tools,
  instructions: "You are the assistant inside Maple, a small business banking product. Answer briefly.",
});

// ── mount the agent's door — the host's ONE obligation on this path ──────────
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = new Request(`${publicUrl}${incoming.url}`, {
      method: incoming.method,
      headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]),
      ...(body.length === 0 ? {} : { body }),
    });
    if (!incoming.url.startsWith(DOOR_PATH)) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const response = await byo.door(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) outgoing.end();
    else Readable.fromWeb(response.body).pipe(outgoing);
  } catch (error) {
    console.error("[byo] door relay error:", error?.message ?? error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`[byo] door host listening on :${PORT}, public origin ${publicUrl}`);

// cloudflared prints its hostname before the edge has it in DNS — poll first.
{
  const deadline = Date.now() + 120_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(`${publicUrl}${DOOR_PATH}`, { method: "GET" })).status > 0;
    } catch {
      await sleep(1500);
    }
  }
  if (!up) {
    console.error("[byo] the tunnel never became reachable");
    process.exit(2);
  }
  console.log("[byo] tunnel reachable from the public internet");
}

let failed = false;
try {
  // ── session ONE ─────────────────────────────────────────────────────────────
  const one = await byo.session(SUBJECT);
  console.log(`\n[byo] session one: ${one.threadId}`);

  // 1+2 · a box boots, the model thinks with HOST data through the door.
  const readResponse = await one.stream("How many invoices are outstanding, and what is the id? One short sentence.", { signal: AbortSignal.timeout(600_000) });
  const readText = textOf(await readResponse.text());
  record("1 · a real e2b box booted for the turn", bootedBoxes.length > 0, `box id(s): ${JSON.stringify(bootedBoxes)}`);
  record("2 · the model thought, and answered with the host's data", readText.includes("7781"), `model said: ${JSON.stringify(readText.slice(0, 160))}`);
  record("2 · the read executed on the HOST (through the door)", hostExecutions.includes("maple_invoices_list"), JSON.stringify(hostExecutions));

  // 4 · the guarded call: parked mid-turn, then approved, then the turn resumes.
  const approval = { seen: undefined, decidedAt: undefined, streamDoneFirst: false };
  let streamDone = false;
  const off = one.on("approval", (event) => {
    if (event.request.call?.tool !== "maple_invoice_pay" || approval.seen !== undefined) return;
    approval.seen = { id: event.request.id, at: Date.now(), streamAlreadyDone: streamDone };
    console.log(`[byo] approval parked: ${event.request.id} (tool ${event.request.call?.tool})`);
    void (async () => {
      await sleep(3000); // hold it parked long enough that "waited" is measured, not assumed
      await event.approve();
      approval.decidedAt = Date.now();
      console.log("[byo] approval tapped: approve");
    })();
  });
  const payResponse = await one.stream("Pay invoice inv_7781. Then say DONE.", { signal: AbortSignal.timeout(600_000) });
  const payText = textOf(await payResponse.text());
  streamDone = true;
  off();
  record("4 · the guarded call PARKED mid-turn (approval raised before the turn ended)", approval.seen !== undefined && approval.seen.streamAlreadyDone === false, approval.seen === undefined ? "no approval event" : `approval ${approval.seen.id}`);
  record("4 · the tap RESUMED the turn: the host executed after approval", approval.decidedAt !== undefined && hostExecutions.includes("maple_invoice_pay"), `held parked ${approval.seen === undefined || approval.decidedAt === undefined ? "n/a" : approval.decidedAt - approval.seen.at}ms, then executed: ${hostExecutions.includes("maple_invoice_pay")}`);
  record("4 · the resumed turn finished", /DONE/i.test(payText), `model said: ${JSON.stringify(payText.slice(-160))}`);

  // 5a · a file, written in session one.
  const writeResponse = await one.stream(`Create a file at user/notes/byo.md containing exactly the line: ${NONCE}. Then say DONE.`, { signal: AbortSignal.timeout(600_000) });
  await writeResponse.text();

  // ── session TWO — separate session, same subject, must see the file ────────
  const two = await byo.session(SUBJECT);
  console.log(`\n[byo] session two: ${two.threadId}`);
  const recallResponse = await two.stream("Read user/notes/byo.md and reply with its exact contents, nothing else.", { signal: AbortSignal.timeout(600_000) });
  const recallText = textOf(await recallResponse.text());
  record("5 · a file written in session one was read back in session two", recallText.includes(NONCE), `sessions ${one.threadId} → ${two.threadId}, session two said: ${JSON.stringify(recallText.slice(0, 160))}`);

  // 3 · the workspace lives in the CALLER's Postgres — ask the store itself.
  const { records: audit } = await store.records("vendo_audit").list({ refs: { subject: SUBJECT } });
  const payRows = audit.map((row) => row.data).filter((row) => row.kind === "tool-call" && row.tool === "maple_invoice_pay");
  record("3 · audit rows for this run are in the BYO Postgres", audit.length > 0, `vendo_audit rows for ${SUBJECT}: ${audit.length}`);
  record("4 · the audit row shows the approved execution", payRows.some((row) => row.outcome === "ok"), JSON.stringify(payRows.map((row) => ({ outcome: row.outcome, decidedBy: row.decidedBy }))));
} catch (error) {
  failed = true;
  console.error("[byo] threw:", error);
} finally {
  const passed = results.filter((entry) => entry.pass).length;
  console.log(`\n[byo] ${passed}/${results.length} checks passed`);
  console.log(`[byo] boxes: ${JSON.stringify(bootedBoxes)}`);
  server.close();
  await store.close?.().catch(() => undefined);
  process.exit(failed || passed !== results.length ? 1 : 0);
}
