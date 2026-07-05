#!/usr/bin/env node
/**
 * Remix fast-edits latency benchmark (spec 2026-07-04, "Benchmarks").
 *
 * Drives a RUNNING demo host's vendo chat route with scoped remix
 * conversations and reports, per turn: wall-clock to first stream part, to the
 * `data-ui` part, total stream bytes, tool parts seen (name × state), hunk
 * failures (edit_view output-error), JSON-parse stream errors, and whether an
 * envelope was paired. Run it on `main` (before) and on the feature branch
 * (after) against the same host + anchor and compare.
 *
 * Usage:
 *   node scripts/remix-bench.mjs [--base http://localhost:3000] [--anchor upcoming-deadlines] \
 *     [--runs 10] [--scenario first|edit|all] [--out bench.json]
 *
 * Prereqs: the demo host running (pnpm demo:accounting), ANTHROPIC_API_KEY set
 * server-side. First remix + follow-up edit scenarios; "edit" reuses the
 * envelope captured from the first remix of the same run (skipped with a note
 * when the server ships none, e.g. on main). Server-side apply/compile timings
 * come from VENDO_BENCH=1 logs on the server, not this client.
 * send→stage-rendered is measured separately in the browser (Task 12), not here.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((p) => p.length),
);
const BASE = args.base ?? "http://localhost:3000";
const ANCHOR = args.anchor ?? "upcoming-deadlines";
const RUNS = Number(args.runs ?? 10);
const SCENARIO = args.scenario ?? "all";

/** Varied remix asks (N ≥ 10 for the reliability rates). */
const FIRST_ASKS = [
  "make the header accent colored",
  "make the title bigger and bolder",
  "show the items as a numbered list",
  "add a subtle border around each item",
  "make overdue items stand out in red",
  "add a count of items to the header",
  "use a two-column layout for the items",
  "make it more compact — tighter spacing",
  "add an icon before the title",
  "sort the items alphabetically and show it that way",
];
const EDIT_ASKS = [
  "now make the header even bigger",
  "also underline the title",
  "change the accent to a softer tone",
  "add a footer line with a total count",
  "make the first item bold",
  "round the corners more",
  "add more padding around everything",
  "make the title uppercase",
  "shrink the text a little",
  "give the header a background tint",
];

const SNAPSHOT =
  '<div class="deadlines"><h3>Upcoming deadlines</h3><ul><li>Acme VAT return — Jul 12</li><li>Beta payroll — Jul 15</li></ul></div>';
const CONTEXT = {
  items: [
    { id: "d1", name: "Acme VAT return", due: "2026-07-12" },
    { id: "d2", name: "Beta payroll", due: "2026-07-15" },
  ],
};

let msgCounter = 0;
const scopedMessage = (text, envelope) => ({
  id: `bench-${++msgCounter}`,
  role: "user",
  parts: [{ type: "text", text }],
  metadata: {
    anchors: {
      scoped: {
        anchorId: ANCHOR,
        label: "Upcoming deadlines",
        context: CONTEXT,
        snapshot: SNAPSHOT,
        ...(envelope ? { envelope } : {}),
      },
    },
  },
});

/** POST one turn; parse the SSE UIMessage stream; collect metrics. */
async function runTurn(messages) {
  const started = performance.now();
  const metrics = {
    ok: false,
    httpStatus: 0,
    firstPartMs: null,
    dataUiMs: null,
    totalMs: null,
    streamBytes: 0,
    toolParts: {},
    hunkFailures: 0,
    streamErrors: 0,
    envelope: null,
    uiNodeId: null,
    error: null,
  };
  let res;
  try {
    res = await fetch(`${BASE}/api/vendo/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
  } catch (e) {
    metrics.error = `fetch failed: ${e.message}`;
    return metrics;
  }
  metrics.httpStatus = res.status;
  if (!res.ok || !res.body) {
    metrics.error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return metrics;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seenToolStates = new Set();
  // toolName rides only the input-start part; later lifecycle parts carry just
  // the toolCallId — resolve names through this map.
  const toolNames = new Map();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    metrics.streamBytes += value.byteLength;
    if (metrics.firstPartMs === null) metrics.firstPartMs = performance.now() - started;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames: lines starting with "data: "
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      let part;
      try {
        part = JSON.parse(payload);
      } catch {
        metrics.streamErrors += 1;
        continue;
      }
      const type = String(part.type ?? "");
      if (type === "data-ui" && metrics.dataUiMs === null) {
        metrics.dataUiMs = performance.now() - started;
        metrics.uiNodeId = part.data?.id ?? null;
      }
      if (type === "data-remix-envelope") metrics.envelope = part.data?.envelope ?? null;
      if (type === "error") metrics.streamErrors += 1;
      // Tool lifecycle parts: count name×state once per call id.
      if (type === "tool-input-start" && part.toolCallId) {
        toolNames.set(part.toolCallId, String(part.toolName ?? "?"));
      }
      if (type === "tool-input-start" || type === "tool-input-available" || type === "tool-output-available" || type === "tool-output-error") {
        const name = toolNames.get(part.toolCallId) ?? String(part.toolName ?? "?");
        const key = `${name}:${type.replace("tool-", "")}`;
        if (!seenToolStates.has(`${part.toolCallId}:${key}`)) {
          seenToolStates.add(`${part.toolCallId}:${key}`);
          metrics.toolParts[key] = (metrics.toolParts[key] ?? 0) + 1;
          if (name === "edit_view" && type === "tool-output-error") metrics.hunkFailures += 1;
        }
        // edit_view RESULTS that are correctable errors come back as
        // output-available with an "edit_view error (...)" string.
        if (
          type === "tool-output-available" &&
          name === "edit_view" &&
          String(part.output ?? "").startsWith("edit_view error")
        ) {
          metrics.hunkFailures += 1;
        }
      }
    }
  }
  metrics.totalMs = performance.now() - started;
  metrics.ok = metrics.dataUiMs !== null;
  return metrics;
}

const pick = (arr, i) => arr[i % arr.length];
const stats = (values) => {
  const v = values.filter((x) => x !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return {
    n: v.length,
    p50: Math.round(v[mid]),
    min: Math.round(v[0]),
    max: Math.round(v[v.length - 1]),
    mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
  };
};

async function main() {
  console.log(`remix-bench → ${BASE} anchor=${ANCHOR} runs=${RUNS} scenario=${SCENARIO}`);
  const results = { base: BASE, anchor: ANCHOR, first: [], edit: [], noEnvelopeNote: null };

  for (let i = 0; i < RUNS; i++) {
    if (SCENARIO === "first" || SCENARIO === "all") {
      const ask = pick(FIRST_ASKS, i);
      process.stdout.write(`  first[${i}] "${ask}" … `);
      const first = await runTurn([scopedMessage(ask)]);
      results.first.push({ ask, ...first });
      console.log(first.ok ? `${Math.round(first.dataUiMs)}ms` : `FAILED (${first.error ?? "no data-ui"})`);

      if ((SCENARIO === "all") && first.ok) {
        // Follow-up edit against the pin envelope from the first turn (when
        // the server minted one — on main there is none; note and skip).
        if (first.envelope) {
          const ask2 = pick(EDIT_ASKS, i);
          process.stdout.write(`  edit [${i}] "${ask2}" … `);
          const edit = await runTurn([scopedMessage(ask2, first.envelope)]);
          results.edit.push({ ask: ask2, ...edit });
          console.log(edit.ok ? `${Math.round(edit.dataUiMs)}ms` : `FAILED (${edit.error ?? "no data-ui"})`);
        } else if (!results.noEnvelopeNote) {
          results.noEnvelopeNote = "server shipped no remix envelope — pin-edit scenario skipped (expected on main)";
          console.log(`  edit: ${results.noEnvelopeNote}`);
        }
      }
    } else if (SCENARIO === "edit") {
      console.log("  --scenario edit requires 'all' (the edit turn consumes the first turn's envelope)");
      break;
    }
  }

  const summarize = (turns) => ({
    dataUiMs: stats(turns.map((t) => t.dataUiMs)),
    firstPartMs: stats(turns.map((t) => t.firstPartMs)),
    streamBytes: stats(turns.map((t) => (t.ok ? t.streamBytes : null))),
    failures: turns.filter((t) => !t.ok).length,
    hunkFailures: turns.reduce((a, t) => a + t.hunkFailures, 0),
    streamErrors: turns.reduce((a, t) => a + t.streamErrors, 0),
    toolMix: turns.reduce((acc, t) => {
      for (const [k, v] of Object.entries(t.toolParts)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {}),
  });

  const summary = {
    meta: { base: BASE, anchor: ANCHOR, runs: RUNS, scenario: SCENARIO },
    first: summarize(results.first),
    edit: results.edit.length > 0 ? summarize(results.edit) : results.noEnvelopeNote,
  };
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.out, JSON.stringify({ summary, results }, null, 2));
    console.log(`\nraw results → ${args.out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
