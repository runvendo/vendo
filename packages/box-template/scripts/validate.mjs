#!/usr/bin/env node
/**
 * `npm run validate` — the gate the builder must pass before it reports done
 * (blueprint §7.1 part 4).
 *
 * THE CONTRACT, for whoever calls this:
 *   - exit 0  → shippable. Every check ran and found nothing.
 *   - exit 1  → NOT shippable. stdout carries the findings, one per line.
 *   - stdout  → a `validate: <n> checks ran, <m> findings` header, then each
 *               finding as `  ✗ <check>: <what is wrong>`.
 *
 * Code validity comes from the REAL toolchain (founder ruling 2026-08-04): `tsc`
 * and `vite build` are the code validators, and both are free in the box. There
 * is not one line of hand-rolled syntax checking here, and there must never be.
 * What this adds is only what the toolchain CANNOT know — the facts about the
 * skin contract and the built output that no type checker can see.
 *
 * Nothing to check is NOT a pass. A check that could not run is a finding, so a
 * missing build can never report "shippable" for an app nobody examined.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];
let checks = 0;

const finding = (check, detail) => findings.push(`  ✗ ${check}: ${detail}`);

/** Run one npm script and keep its output as the finding when it fails. */
const runScript = (check, script) => {
  checks += 1;
  const result = spawnSync("npm", ["run", script, "--silent"], { cwd: APP_ROOT, encoding: "utf8" });
  if (result.status === 0) return true;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  finding(check, output === "" ? `npm run ${script} exited ${result.status}` : output);
  return false;
};

// 1 + 2 — the toolchain. Types first: a type error's message is the most useful
// thing a builder can be handed, and the build would only repeat it less clearly.
runScript("typecheck", "typecheck");
const builtOk = runScript("build", "build");

// 3 — the app's entry line. Empty or missing means the supervisor starts NOTHING
// (packages/apps/box/harness.mjs readRunEntry), and the app is simply never up.
checks += 1;
const runFile = [path.join(APP_ROOT, ".vendo", "run"), path.join(APP_ROOT, "run")].find(existsSync);
if (runFile === undefined) {
  finding("run-entry", "no .vendo/run — the supervisor starts nothing without it");
} else if (readFileSync(runFile, "utf8").trim() === "") {
  finding("run-entry", `${path.relative(APP_ROOT, runFile)} is empty — the supervisor starts nothing`);
}

// 4 — the manifest must at least be readable JSON. Its SCHEMA is gated host-side
// by parseVendoManifest (packages/apps/src/manifest.ts) after every edit; a
// second copy of that schema in here would be a second implementation of one
// contract, so this only catches the file being unparseable in the first place.
checks += 1;
try {
  const manifest = JSON.parse(readFileSync(path.join(APP_ROOT, "vendo.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    finding("manifest", "vendo.json must be a JSON object with schedules/egress");
  }
} catch (error) {
  finding("manifest", `vendo.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
}

// 5 — the fn table. `fns.js` is plain JS the type checker never sees, so a
// mistyped export or a non-function handler is invisible until a caller gets a
// 404 for an fn the app believes it serves.
checks += 1;
try {
  const { fns } = await import(new URL("../fns.js", import.meta.url).href);
  if (typeof fns !== "object" || fns === null) {
    finding("fns", "fns.js must export `const fns = { ... }`");
  } else {
    for (const [name, handler] of Object.entries(fns)) {
      if (typeof handler !== "function") finding("fns", `fn "${name}" is not a function`);
    }
  }
} catch (error) {
  finding("fns", `fns.js does not load: ${error instanceof Error ? error.message : String(error)}`);
}

// 6 — the built entry page. Two facts the toolchain cannot know, both of which
// break the app only once it is SERVED, which is the worst time to find out.
checks += 1;
const entry = path.join(APP_ROOT, "dist", "index.html");
if (!existsSync(entry)) {
  finding("served-page", builtOk
    ? "dist/index.html is missing even though the build succeeded"
    : "dist/index.html is missing because the build failed");
} else {
  const page = readFileSync(entry, "utf8");
  // The box's egress is deny-by-default, so a CDN reference is a guaranteed
  // failed fetch in production even though it worked on the builder's machine.
  if (/(?:src|href)="https?:\/\//.test(page)) {
    finding("served-page", "the entry page loads something over http(s) — the box's egress is deny-by-default, so bundle it instead");
  }
  // A shared app is served under `/apps/<id>/serve/`, so an absolute asset URL
  // leaves the mount and 404s on the host origin. `base: "./"` is what keeps
  // them relative; a config change that drops it fails here.
  if (/(?:src|href)="\/[^/]/.test(page)) {
    finding("served-page", "the entry page references an asset with an absolute path — keep vite's `base: \"./\"` so a proxied app resolves its own assets");
  }
}

const header = `validate: ${checks} checks ran, ${findings.length === 0 ? "no findings — shippable" : `${findings.length} findings`}`;
console.log([header, ...findings].join("\n"));
process.exit(findings.length === 0 ? 0 : 1);
