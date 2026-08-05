#!/usr/bin/env node
// TEST SCAFFOLDING ONLY — session-two retest of the BYO leg's file-persistence check, with the reply logged in full. Never product.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import process from "node:process";

const dist = (file) => pathToFileURL(new URL(`../../../packages/agents/dist/${file}`, import.meta.url).pathname).href;
const { agent, postgres, e2b, DOOR_PATH } = await import(dist("index.js"));
const { claudeCode } = await import(dist("harnesses.js"));

const PORT = Number(process.env.PROOF_PORT ?? 8788);
const publicUrl = process.env.PROOF_PUBLIC_URL;
const MODEL = process.env.VENDO_LIVE_MODEL ?? "claude-sonnet-4-5";
const SUBJECT = "user_byo_p10";

const store = postgres(process.env.BYO_PG_URL);
const byo = agent({
  name: "byo-accept",
  harness: claudeCode({ model: MODEL, template: process.env.VENDO_BOX_TEMPLATE, maxTurns: 14 }),
  store,
  sandbox: e2b({ apiKey: process.env.E2B_API_KEY, template: process.env.VENDO_BOX_TEMPLATE, timeoutMs: 15 * 60_000 }),
  door: { baseUrl: publicUrl },
  instructions: "You are the assistant inside Maple, a small business banking product. Answer briefly.",
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (!incoming.url.startsWith(DOOR_PATH)) { outgoing.writeHead(404); outgoing.end(); return; }
    const response = await byo.door(new Request(`${publicUrl}${incoming.url}`, {
      method: incoming.method,
      headers: Object.entries(incoming.headers).flatMap(([k, v]) => v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v]]),
      ...(body.length === 0 ? {} : { body }),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) outgoing.end();
    else Readable.fromWeb(response.body).pipe(outgoing);
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));
for (let tries = 0; tries < 40; tries++) {
  try { await fetch(`${publicUrl}${DOOR_PATH}`); break; } catch { await sleep(1500); }
}

const two = await byo.session(SUBJECT);
console.log(`[recall] session: ${two.threadId}`);
const response = await two.stream("Read the file user/notes/byo.md and reply with its exact contents, nothing else.", { signal: AbortSignal.timeout(600_000) });
const raw = await response.text();
const text = raw.split("\n").filter((l) => l.startsWith("data: ")).flatMap((l) => {
  try { const p = JSON.parse(l.slice(6)); return p.type === "text-delta" ? [p.delta] : []; } catch { return []; }
}).join("");
console.log(`[recall] model said: ${JSON.stringify(text)}`);
console.log(`[recall] raw tail: ${JSON.stringify(raw.slice(-600))}`);
console.log(`[recall] ${text.includes("BYO-P10-4417") ? "PASS" : "FAIL"} · session ${two.threadId} read the file back`);
server.close();
await store.close?.().catch(() => undefined);
process.exit(text.includes("BYO-P10-4417") ? 0 : 1);
