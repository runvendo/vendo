/**
 * `vendo sync [dir]` — the per-build refresh of everything Vendo derives
 * from the app source. Capture is a PER-BUILD concern, not an install-time
 * one: `vendo init` merely wires this command into `prebuild` and runs it
 * once (expected empty on a fresh install — no wrappers exist yet).
 *
 * Steps: capture remix sources → build the sandbox environment (vendored
 * deps, host CSS, catalog registrations, manifest). Fail-open per item; the
 * command only exits non-zero on its own bugs, never on classification gaps.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureRemixSources } from "./capture.js";
import { buildEnvironment } from "./env.js";

export interface SyncOptions {
  targetDir: string;
  now?: () => string;
  log?: (line: string) => void;
}

export async function runSync(options: SyncOptions): Promise<number> {
  const log = options.log ?? console.log;
  const targetDir = path.resolve(options.targetDir);
  const vendoDir = path.join(targetDir, ".vendo");

  log("vendo sync");
  const capture = captureRemixSources(targetDir, {
    ...(options.now ? { now: options.now } : {}),
  });
  mkdirSync(vendoDir, { recursive: true });
  writeFileSync(
    path.join(vendoDir, "remix-sources.json"),
    `${JSON.stringify(capture.records, null, 2)}\n`,
  );
  for (const line of capture.report) log(`  ${line}`);

  const env = await buildEnvironment(targetDir, capture.records, {
    ...(options.now ? { now: options.now } : {}),
  });
  for (const line of env.report) log(`  ${line}`);

  log(`  wrote .vendo/remix-sources.json (${Object.keys(capture.records).length} captured)`);
  return 0;
}
