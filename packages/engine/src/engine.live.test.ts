import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

/**
 * Live end-to-end gate: a real Agent SDK session through this package's own
 * runner (no scripted seam) — the CLI reads a job from stdin, runs the real
 * `createSdkQuery()` default, and the final text lands on stdout. Mirrors
 * the gating shape of `extract-theme.live.test.ts`: skipped without a real
 * credential, so it never runs (or costs anything) in ordinary CI.
 *
 * Env-flagged on top of the credential check (VENDO_ENGINE_LIVE=1) so this
 * ~245MB-SDK, real-network test only ever runs when explicitly asked for —
 * unlike the extraction harness's live test, which only needs an API key
 * because its harness is already a normal in-repo dependency.
 */
const hasKey = typeof process.env["ANTHROPIC_API_KEY"] === "string" && process.env["ANTHROPIC_API_KEY"]!.trim().length > 0;
const live = process.env["VENDO_ENGINE_LIVE"] === "1" && hasKey;

describe.skipIf(!live)("vendo-engine live run", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendo-engine-live-"));
  const marker = "vendo-engine-live-marker-7f3a9c";
  writeFileSync(join(dir, "marker.txt"), marker, "utf8");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a real file through the read-only tool policy and returns exactly the final text on stdout", async () => {
    const job = JSON.stringify({
      instructions:
        `Read the file "marker.txt" in the current directory and reply with ONLY its exact contents, nothing else — no preamble, no quotes, no explanation.`,
      root: dir,
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["run"], {
      stdin: Readable.from([Buffer.from(job, "utf8")]),
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(code, `stderr: ${err.join("")}`).toBe(0);
    expect(out.join("")).toContain(marker);
  }, 120_000);
});
