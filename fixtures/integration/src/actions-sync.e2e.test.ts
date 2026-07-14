/** J8 — ACTIONS OPENAPI SYNC → callable over the composed wire.
 *
 * `vendoSync` is the build-time extractor (packages/actions/src/sync): it reads a
 * host project's OpenAPI spec (+ route scan), and writes `.vendo/tools.json` — the
 * SAME contract file `createVendo` loads at boot (`createActions({ dir: "." })`).
 * This journey proves the whole loop end to end against the REAL fixture host:
 *
 *   1. run `vendoSync` against the fixture host-app's real `openapi.json`,
 *   2. it produces a schema-valid `.vendo/tools.json` carrying the extracted host
 *      tools (host_listInvoices=read, host_createInvoice=write, …),
 *   3. author the governance `.vendo/policy.json` (init scaffolds this; sync owns
 *      only tools.json) so the read tool runs without an approval, and
 *   4. boot the REAL composed umbrella with that freshly-synced `.vendo/` as its
 *      cwd and drive a chat turn that calls one synced tool over the PUBLIC wire —
 *      the composed guard binds it, actions executes its route binding as a real
 *      HTTP call to the fixture host, and the invoices come back on the stream.
 *
 * Nothing here is hand-wired: the tool the wire calls exists ONLY because sync
 * extracted it from the spec moments earlier.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vendoSync } from "@vendoai/actions";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  readSse,
  resetFixture,
  textTurn,
  toolCallTurn,
  type Stack,
} from "./harness.js";

const HOST_APP_ROOT = fileURLToPath(new URL("../../host-app", import.meta.url));

const POLICY = {
  format: "vendo/policy@1",
  rules: [
    { match: { risk: "read" }, action: "run" },
    { match: { risk: "write" }, action: "run" },
    { match: { risk: "destructive" }, action: "ask" },
  ],
} as const;

interface SyncedTool {
  name: string;
  risk: string;
  binding: { kind: string; path: string; method?: string };
}

let stack: Stack | undefined;
let projectDir: string | undefined;
const originalCwd = process.cwd();

afterEach(async () => {
  await stack?.close();
  stack = undefined;
  process.chdir(originalCwd);
  if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true });
  projectDir = undefined;
});

describe("J8: OpenAPI sync produces tools.json whose tools are callable over the wire", () => {
  it("syncs the fixture spec, then a wire chat turn calls a synced tool for real host data", async () => {
    await resetFixture();

    // --- 1/2. Sync the REAL fixture spec into a fresh project's .vendo/ --------
    projectDir = await mkdtemp(join(tmpdir(), "vendo-j8-"));
    const dotVendo = join(projectDir, ".vendo");
    const report = await vendoSync({ root: HOST_APP_ROOT, out: dotVendo });
    expect(Array.isArray(report.warnings)).toBe(true);

    const toolsFile = JSON.parse(await readFile(join(dotVendo, "tools.json"), "utf8")) as {
      format: string;
      tools: SyncedTool[];
    };
    expect(toolsFile.format).toBe("vendo/tools@1");
    const byName = new Map(toolsFile.tools.map((tool) => [tool.name, tool]));

    // The read + write invoice tools were extracted straight from the spec.
    const listInvoices = byName.get("host_listInvoices");
    expect(listInvoices?.risk).toBe("read");
    expect(listInvoices?.binding.path).toBe("/api/invoices");
    expect(byName.get("host_createInvoice")?.risk).toBe("write");
    // Every extracted tool name is contract-legal.
    expect(toolsFile.tools.every((tool) => /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name))).toBe(true);

    // --- 3. Author the governance file init would scaffold beside tools.json ---
    await mkdir(dotVendo, { recursive: true });
    await writeFile(join(dotVendo, "policy.json"), `${JSON.stringify(POLICY, null, 2)}\n`, "utf8");

    // --- 4. Boot the composed umbrella with this synced .vendo/ as cwd ---------
    // createVendo does createActions({ dir: "." }) + policy { file: ".vendo/policy.json" }
    // relative to cwd, so the freshly-synced contract is what the wire loads.
    process.chdir(projectDir);
    stack = await createStack({
      turns: [
        toolCallTurn("host_listInvoices", {}, "call_sync"),
        textTurn("Here are your invoices.", "t1"),
      ],
    });

    const turn = await readSse(
      await stack.wireFetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thr_j8",
          message: { id: "u1", role: "user", parts: [{ type: "text", text: "List my invoices" }] },
        }),
      }, ADA),
    );

    // The stream completed and the agent's closing text landed.
    expect(turn.raw.includes("[DONE]")).toBe(true);
    expect(turn.raw.includes("Here are your invoices.")).toBe(true);

    // The synced tool executed through the composed guard/actions as a real HTTP
    // round-trip to the fixture host: the audit trail records the tool-call ok.
    const audit = await stack.sql<{ tool: string; outcome: string }>(
      "SELECT tool, outcome FROM vendo_audit WHERE subject = $1 AND kind = 'tool-call'",
      [ADA.subject],
    );
    expect(audit).toContainEqual({ tool: "host_listInvoices", outcome: "ok" });

    // And the host's real invoices came back on the stream (seed data over the wire).
    expect(turn.raw).toMatch(/inv_/);
  });
});
