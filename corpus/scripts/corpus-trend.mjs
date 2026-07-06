#!/usr/bin/env node
// Compare two corpus scorecard.json documents and print a markdown delta table.
// Usage: node corpus/scripts/corpus-trend.mjs <previous.json> <current.json>
// If <previous.json> is missing or unreadable, prints a "baseline run" note.

import { readFile } from "node:fs/promises";

async function readScorecard(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function layerKey(repo, layer) {
  return `${repo}::${layer.layer}`;
}

function indexLayers(scorecard) {
  const map = new Map();
  if (!scorecard?.repos) return map;
  for (const repo of scorecard.repos) {
    for (const layer of repo.layers ?? []) {
      map.set(layerKey(repo.repo, layer), layer);
    }
  }
  return map;
}

function scoreText(layer) {
  if (layer?.score) return `${layer.score.passed}/${layer.score.total}`;
  return layer?.status ?? "—";
}

function deltaMarker(prev, curr) {
  const p = prev?.score?.value;
  const c = curr?.score?.value;
  if (p === undefined || c === undefined) {
    if (prev?.status && curr?.status && prev.status !== curr.status) return `${prev.status} → ${curr.status}`;
    return "";
  }
  if (c > p) return "🟢 improved";
  if (c < p) return "🔴 regressed";
  return "▪ same";
}

const [, , prevPath, currPath] = process.argv;

const current = await readScorecard(currPath);
if (!current) {
  console.log("No current scorecard found; nothing to report.");
  process.exit(0);
}

const previous = prevPath ? await readScorecard(prevPath) : null;

const lines = [];
lines.push("## Corpus trend");
lines.push("");
lines.push(
  `Current: ${current.summary.passedLayers}/${current.summary.layerCount} layers passing, ` +
    `${current.summary.hardFailureCount} hard failures (generated ${current.generatedAt}).`,
);
lines.push("");

if (!previous) {
  lines.push("_No previous scorecard available — this is the baseline run._");
  console.log(lines.join("\n"));
  process.exit(0);
}

const prevIndex = indexLayers(previous);
const currIndex = indexLayers(current);
const keys = [...new Set([...prevIndex.keys(), ...currIndex.keys()])].sort();

lines.push("| Repo · Layer | Before | After | Δ |");
lines.push("| --- | --- | --- | --- |");
for (const key of keys) {
  const prev = prevIndex.get(key);
  const curr = currIndex.get(key);
  const [repo, layer] = key.split("::");
  lines.push(`| ${repo} · L${layer} | ${scoreText(prev)} | ${scoreText(curr)} | ${deltaMarker(prev, curr)} |`);
}

const regressions = keys.filter((k) => deltaMarker(prevIndex.get(k), currIndex.get(k)).includes("regressed"));
lines.push("");
lines.push(
  regressions.length > 0
    ? `⚠️ ${regressions.length} layer(s) regressed vs the previous run.`
    : "No regressions vs the previous run.",
);

console.log(lines.join("\n"));
