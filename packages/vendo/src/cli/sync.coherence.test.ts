import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "./sync.js";

/**
 * What the `vendo sync` WRAPPER owns, now that the flow itself lives in
 * sync-flow.ts (and is tested there): who counts as interactive, and the
 * one-object stdout contract.
 */

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const REPORT = {
  tools: { added: [], removed: [], changed: [] },
  breaking: [],
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 0, registered: 0 },
  components: { captured: [], drifted: [] },
  warnings: [],
};

const scan = async () => REPORT;

function captureOutput() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) }, logs, errors };
}

const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

async function host(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vendo-sync-coherence-"));
  dirs.push(dir);
  await mkdir(join(dir, ".vendo"), { recursive: true });
  return dir;
}

/** A harness that fails loudly if the judgment pass so much as probes it. */
const forbidden = {
  id: "never",
  availability: async () => { throw new Error("the judgment pass must not run here"); },
  run: async () => { throw new Error("the judgment pass must not run here"); },
};

// I1 (review): existing installs have a bare `predev: vendo sync`. npm
// inherits the terminal, so without this exemption `npm run dev` blocks on a
// default-yes prompt and a reflexive Enter starts spending.
it("a package-script run is never interactive, even with a TTY", async () => {
  vi.stubEnv("npm_lifecycle_event", "predev");
  // A REAL TTY, or the assertion is vacuous: this is exactly the shape
  // `npm run dev` hands its predev hook.
  const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  const messages = captureOutput();
  expect(await runSync({
    targetDir: await host(),
    output: messages.output,
    fetchImpl: offline,
    sync: scan,
    judge: {
      harnesses: [forbidden],
      confirm: async () => { throw new Error("prompted inside an npm lifecycle hook"); },
    },
  }).finally(() => {
    process.stdin.isTTY = tty.in;
    process.stdout.isTTY = tty.out;
  })).toBe(0);
  expect(messages.logs.join("\n")).toContain("judgment: skipped — this run cannot ask");
});

describe("--yes and --json are non-interactive by construction", () => {
  it("neither ever prompts", async () => {
    for (const flags of [{ yes: true }, { json: true }] as const) {
      const messages = captureOutput();
      expect(await runSync({
        targetDir: await host(),
        output: messages.output,
        fetchImpl: offline,
        sync: scan,
        ...flags,
        judge: {
          harnesses: [forbidden],
          confirm: async () => { throw new Error("prompted") },
        },
      })).toBe(0);
    }
  });

  it("--json still emits exactly one object", async () => {
    const messages = captureOutput();
    expect(await runSync({
      targetDir: await host(),
      output: messages.output,
      fetchImpl: offline,
      sync: scan,
      json: true,
      judge: { harnesses: [forbidden], confirm: async () => { throw new Error("prompted") } },
    })).toBe(0);
    expect(messages.logs).toHaveLength(1);
    const result = JSON.parse(messages.logs[0]!) as { theme: unknown; baselines: unknown };
    expect(result.theme).toBeNull();
    expect(result.baselines).toBeNull();
  });
});
