/**
 * Rematch gate — design pairwise judge (claude-opus-4-8, blind labels, both
 * orderings, agreement rule; ties on disagreement). Mirrors the 2026-07-21
 * v4 gate protocol (docs/eval/runs/2026-07-21/design-pairwise.md).
 *
 * Usage: ANTHROPIC_API_KEY=... node judge-pairwise.mjs <shotsDir> <outJson>
 *   Expects <shotsDir>/H<NN>-A.png / -B.png / -C.png (width-800 resamples).
 *   Judges B-vs-A and C-vs-A for every prompt with both images present.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , shotsDir, outJson] = process.argv;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey || !shotsDir || !outJson) {
  console.error("usage: ANTHROPIC_API_KEY=... node judge-pairwise.mjs <shotsDir> <outJson>");
  process.exit(2);
}

const MODEL = "claude-opus-4-8";
const CRITERIA = `You are judging which of two generated app screenshots is better DESIGNED. Criteria, in order: visual hierarchy (one clear hero), layout balance (no dead space, no lone floating cards), density consistency, humanized labels (no raw enums, raw cents, or raw ISO timestamps), brand feel (looks like the host product shipped it), designed empty states. Explicitly EXCLUDE feature count — more sections is not better. Answer with EXACTLY one word: A or B.`;

const b64 = (path) => readFileSync(path).toString("base64");

async function judgeOnce(imageA, imageB) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await judgeOnceInner(imageA, imageB);
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((res) => setTimeout(res, attempt * 3000));
    }
  }
}

async function judgeOnceInner(imageA, imageB) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: CRITERIA },
          { type: "text", text: "Screenshot A:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: b64(imageA) } },
          { type: "text", text: "Screenshot B:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: b64(imageB) } },
          { type: "text", text: "Which is better designed? Answer A or B only." },
        ],
      }],
    }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`judge call failed ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const text = (json.content?.[0]?.text ?? "").trim().toUpperCase();
  if (text !== "A" && text !== "B") throw new Error(`non-verdict answer: ${text}`);
  return text;
}

const results = [];
for (let i = 1; i <= 30; i += 1) {
  const id = `H${i}`;
  const control = join(shotsDir, `${id}-A.png`);
  for (const arm of ["B", "C"]) {
    const candidate = join(shotsDir, `${id}-${arm}.png`);
    if (!existsSync(control) || !existsSync(candidate)) {
      results.push({ id, comparison: `${arm}-vs-A`, verdict: "SKIP", reason: "missing screenshot" });
      continue;
    }
    // Ordering 1: label A = candidate arm, label B = control.
    const o1 = await judgeOnce(candidate, control);
    // Ordering 2: label A = control, label B = candidate arm.
    const o2 = await judgeOnce(control, candidate);
    const pick1 = o1 === "A" ? arm : "control";
    const pick2 = o2 === "A" ? "control" : arm;
    const verdict = pick1 === pick2 ? (pick1 === arm ? arm : "A") : "TIE";
    results.push({ id, comparison: `${arm}-vs-A`, o1, o2, verdict });
    console.log(`${id} ${arm}-vs-A: o1=${o1} o2=${o2} -> ${verdict}`);
  }
}
writeFileSync(outJson, JSON.stringify({ model: MODEL, protocol: "blind labels, both orderings, agreement rule, ties on disagreement", results }, null, 2));
console.log(`wrote ${outJson}`);
