import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvFiles, runSyncFlow } from "./sync-flow.js";

/**
 * The ONE flow `vendo init` (mode "full") and `vendo sync` (mode "incremental")
 * both run: one env reader that sees BOTH dotenv files, one consent question,
 * one theme path (create when missing, reconcile when present).
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function host(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-sync-flow-"));
  dirs.push(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(root, name), source, "utf8");
  }
  return root;
}

function captureOutput() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) }, logs, errors };
}

const REPORT = {
  tools: { added: [], removed: [], changed: [] },
  breaking: [],
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 0, registered: 0 },
  components: { captured: [], drifted: [] },
  warnings: [],
};

const scan = (async () => REPORT) as never;

/** A judged catalog whose one tool is unchanged: incremental has nothing to do,
 *  full re-judges it. The difference IS the mode, read through the real pass. */
const JUDGED_CATALOG = {
  "tools.json": `${JSON.stringify({
    format: "vendo/tools@3",
    tools: [{
      name: "host_a",
      description: "Use this to call host_a.",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/a", argsIn: "query" },
    }],
  })}\n`,
  "judgments.json": `${JSON.stringify({
    format: "vendo/judgments@1",
    tools: {
      host_a: {
        binding: "GET /api/a",
        fields: { description: "Reads the counter." },
        evidence: "export async function GET() {",
      },
    },
  })}\n`,
};

describe("readEnvFiles", () => {
  /** init's defect: it read `.env.local` ONLY, so a key sitting in `.env` was
   *  invisible and the run went structural-only with no signal why. */
  it("reads .env AND .env.local, with .env.local winning", async () => {
    const root = await host({ ".env": "A=from-env\nB=only-env\n", ".env.local": "A=from-local\n" });
    const env = await readEnvFiles(root);
    expect(env.A).toBe("from-local");
    expect(env.B).toBe("only-env");
  });

  it("lets a concrete process value win, but not a blank one", async () => {
    const root = await host({ ".env": "VENDO_API_KEY=from-file\n" });
    const previous = process.env.VENDO_API_KEY;
    process.env.VENDO_API_KEY = "  ";
    try {
      expect((await readEnvFiles(root)).VENDO_API_KEY).toBe("from-file");
      process.env.VENDO_API_KEY = "real";
      expect((await readEnvFiles(root)).VENDO_API_KEY).toBe("real");
    } finally {
      if (previous === undefined) delete process.env.VENDO_API_KEY;
      else process.env.VENDO_API_KEY = previous;
    }
  });
});

describe("runSyncFlow", () => {
  it("judges the WHOLE catalog in full mode and only what moved in incremental", async () => {
    const invocations: number[] = [];
    for (const mode of ["incremental", "full"] as const) {
      const root = await host(JUDGED_CATALOG);
      // The `.vendo` copies are what the pass reads.
      for (const [name, source] of Object.entries(JUDGED_CATALOG)) {
        await writeFile(join(root, ".vendo", name), source, "utf8");
      }
      let calls = 0;
      const { output } = captureOutput();
      await runSyncFlow({
        root, output, mode, interactive: false, yes: true, ai: true, sync: scan,
        judge: {
          harness: {
            id: "scripted",
            availability: async () => "a scripted engine",
            run: async () => {
              calls += 1;
              return "```json\n" + JSON.stringify({ tools: [], narrative: "" }) + "\n```";
            },
          },
        },
      });
      invocations.push(calls);
    }
    expect(invocations).toEqual([0, 1]);
  });

  it("asks for consent exactly ONCE, with the same question in both modes", async () => {
    const asked: string[] = [];
    const engine = {
      id: "scripted",
      availability: async () => "a scripted engine",
      run: async () => { throw new Error("declined consent must never reach the engine"); },
    };
    for (const mode of ["full", "incremental"] as const) {
      const { output } = captureOutput();
      await runSyncFlow({
        root: await host(), output, mode, interactive: true, yes: false, sync: scan,
        confirm: async (question: string) => { asked.push(question); return false; },
        judge: { harnesses: [engine] },
      });
    }
    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(asked[1]);
  });

  it("creates .vendo/theme.json when absent and reconciles it when present", async () => {
    const root = await host();
    const { output } = captureOutput();
    const created = await runSyncFlow({
      root, output, mode: "full", interactive: false, yes: true, ai: false, sync: scan,
    });
    expect(created.theme).toBeNull();
    await expect(readFile(join(root, ".vendo", "theme.json"), "utf8")).resolves.toContain("colors");

    const reconciled = await runSyncFlow({
      root, output, mode: "incremental", interactive: false, yes: true, ai: false, sync: scan,
    });
    expect(reconciled.theme).not.toBeNull();
  });
});
