/**
 * `vendo sync [dir]` — the per-build refresh of everything Vendo derives
 * from the app source. Capture is a PER-BUILD concern, not an install-time
 * one: `vendo init` merely wires this command into `prebuild` and runs it
 * once (expected empty on a fresh install — no wrappers exist yet).
 *
 * Steps: capture remix sources → build the sandbox environment (vendored
 * deps, host CSS, catalog registrations, manifest). Fail-open per item; the
 * command only exits non-zero on its own bugs, never on classification gaps.
 *
 * Output is SILENT MAINTENANCE: a normal run prints a one-line summary and
 * nothing else. It never enumerates routine per-item work and never suggests
 * new things (wrapping components is init/refresh's job). It surfaces a line
 * only when something it maintains is actually broken — an anchored file
 * deleted or its capture refused, or a dependency/shim/copy bundle failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureRemixSources } from "./capture.js";
import { buildEnvironment } from "./env.js";
import { createUi, type Ui } from "../ui.js";

export interface SyncOptions {
  targetDir: string;
  now?: () => string;
  /** Injectable renderer (tests pass a Ui with a capturing sink). */
  ui?: Ui;
}

/**
 * True when a capture/env report line reports genuine breakage in something
 * sync maintains — an anchored file deleted or unreadable, a capture refused
 * by the threat model, a malformed configured override, or a dependency /
 * shim / copy bundle failure — as opposed to routine progress (`captured …`,
 * `env: vendored …`, fallback `note …`) or the fresh-install no-anchors line.
 * Only breakage is surfaced; everything else stays quiet.
 */
function isBreakage(line: string): boolean {
  return (
    line.includes("could not read") || // an anchored source file is gone/unreadable
    line.includes("could not vendor") || // a dependency bundle failed
    line.includes("could not bundle") || // a shim bundle failed
    line.includes("could not copy") || // the env mirror to public/ failed
    line.includes("unreadable") || // vendo.config.json could not be read
    line.includes("exceeds the") || // the vendored bundle blew the soft cap
    line.startsWith("skip override ") || // a configured anchor override is malformed
    line.startsWith("skip:") || // a VendoRemix anchor that cannot be captured
    /^skip [^:]+:/.test(line) // an anchored capture was refused/unreadable (ids may contain spaces)
  );
}

export async function runSync(options: SyncOptions): Promise<number> {
  const ui = options.ui ?? createUi();
  const targetDir = path.resolve(options.targetDir);
  const vendoDir = path.join(targetDir, ".vendo");

  const capture = captureRemixSources(targetDir, {
    ...(options.now ? { now: options.now } : {}),
  });
  mkdirSync(vendoDir, { recursive: true });

  // buildEnvironment may rewrite colliding local import specifiers in the
  // captured records in place, so persist remix-sources.json AFTER it runs —
  // the rewritten baselines are what the runtime loads.
  const env = await buildEnvironment(targetDir, capture.records, {
    ...(options.now ? { now: options.now } : {}),
  });

  writeFileSync(
    path.join(vendoDir, "remix-sources.json"),
    `${JSON.stringify(capture.records, null, 2)}\n`,
  );

  const broken = [...capture.report, ...env.report]
    .filter(isBreakage)
    .map((line) => line.replace(/^env: /, ""));

  const captured = Object.keys(capture.records).length;
  const detail = `${captured} widget${captured === 1 ? "" : "s"} captured`;
  ui.header("vendo sync");
  if (broken.length === 0) {
    ui.step("ok", "environment up to date", detail);
  } else {
    ui.step("warn", "environment refreshed", detail);
    for (const line of broken) ui.warn(line);
  }
  return 0;
}
