#!/usr/bin/env node
/**
 * Wave 6b beat D (ENG-239) — client-disconnect drill against the Vendo wire.
 *
 * Sends a real chat turn (POST /api/vendo/threads, cookie-less: the wire mints
 * an anonymous session) and reads the UI-message stream. In `abort` mode it
 * disconnects the client mid-generation — `AbortController.abort()` on the
 * fetch, the same teardown a closed tab produces — a fixed delay after the
 * first provider-generated stream part, then sits through a settle window.
 *
 * Paired with anthropic-passthrough-proxy.mjs (the host runs with
 * ANTHROPIC_BASE_URL pointed at it), the proxy log is the beat's evidence:
 * the in-flight provider call is torn down at the disconnect timestamp and no
 * further provider request lines appear during the settle window. Without the
 * wave-5 AbortSignal path (ENG-238) the loop would keep calling the provider
 * until the turn finished.
 *
 * Usage:
 *   node client-disconnect.mjs --mode control            # full turn, no abort
 *   node client-disconnect.mjs --mode abort \
 *     [--abort-after-ms 2500] [--settle-seconds 45]
 *   common: [--base http://localhost:3000] [--message "..."]
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const base = arg("base", "http://localhost:3000");
const mode = arg("mode", "abort");
const abortAfterMs = Number(arg("abort-after-ms", 2500));
const settleSeconds = Number(arg("settle-seconds", 45));
const message = arg(
  "message",
  "I'm saving for a trip to Kyoto in November and want to free up $300 a month — where can I cut back? Check my spending and my budgets.",
);

const now = () => new Date().toISOString();
const started = Date.now();
const t = () => `+${String(Date.now() - started).padStart(6)}ms`;

console.log(`[drill] ${now()} mode=${mode} base=${base}`);
console.log(`[drill] message: ${JSON.stringify(message)}`);

const controller = new AbortController();
let response;
try {
  response = await fetch(`${base}/api/vendo/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { id: "beatd-m1", role: "user", parts: [{ type: "text", text: message }] },
    }),
    signal: controller.signal,
  });
} catch (error) {
  console.error(`[drill] request failed before streaming: ${error?.message ?? error}`);
  process.exit(1);
}
console.log(`[drill] ${now()} ${t()} response ${response.status} ${response.headers.get("content-type")}`);
if (response.status !== 200) {
  console.error(`[drill] unexpected status; body: ${await response.text()}`);
  process.exit(1);
}

// Read the SSE stream, tallying part types. The first part that is provider
// output (not stream bookkeeping) marks "generation is live"; in abort mode
// the disconnect timer is armed from that moment.
const partCounts = new Map();
const bookkeeping = new Set(["start", "start-step", "finish-step", "finish", "abort"]);
let aborted = false;
let abortArmed = false;

const decoder = new TextDecoder();
let buffered = "";
const onPart = (part) => {
  const type = part.type ?? "?";
  const seen = (partCounts.get(type) ?? 0) + 1;
  partCounts.set(type, seen);
  if (seen === 1) console.log(`[drill] ${now()} ${t()} first stream part of type ${JSON.stringify(type)}`);
  if (mode === "abort" && !abortArmed && !bookkeeping.has(type)) {
    abortArmed = true;
    console.log(`[drill] ${now()} ${t()} generation is live — disconnecting client in ${abortAfterMs}ms`);
    setTimeout(() => {
      aborted = true;
      console.log(`[drill] ${now()} ${t()} CLIENT DISCONNECT: aborting the fetch mid-generation (same as closing the tab)`);
      controller.abort();
    }, abortAfterMs);
  }
};

try {
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        onPart(JSON.parse(payload));
      } catch {
        /* partial/non-JSON data line */
      }
    }
  }
  console.log(`[drill] ${now()} ${t()} stream ended normally (turn completed)`);
} catch (error) {
  if (aborted) {
    console.log(`[drill] ${now()} ${t()} fetch torn down after client disconnect (${error?.name ?? "error"})`);
  } else {
    console.error(`[drill] ${now()} ${t()} stream error before any abort: ${error?.message ?? error}`);
    process.exit(1);
  }
}

console.log(`[drill] part types seen: ${JSON.stringify(Object.fromEntries(partCounts))}`);

if (mode === "abort") {
  console.log(
    `[drill] ${now()} settling ${settleSeconds}s — the provider-proxy log must show the in-flight call torn down at the disconnect timestamp and NO provider request lines from now on`,
  );
  await new Promise((resolve) => setTimeout(resolve, settleSeconds * 1000));
  console.log(`[drill] ${now()} settle window over`);
}
