import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { vendoSync } from "@vendoai/actions/sync";
import type { ExtractionHarness } from "../extract/harness.js";
import { readPreviousToolsState, runSyncEnrichment, type SyncEnrichmentResult } from "./pass.js";

/**
 * Labeled diff-scenario EVALS (cse lane 1c deliverable 7) — offline and
 * deterministic: fixture repo states, hand-labeled expected affected-tool
 * sets, the REAL structural sync + REAL git diff computation, and a FAKE
 * deterministic model (a static import-tracer standing in for a competent
 * coding agent). The eval asserts the ENGINE's affected-tool identification
 * plumbing: the diff it computes, the hints it derives, and which proposals
 * it accepts. Real-model runs are the live verification pass, never CI.
 */

const run = promisify(execFile);

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-enrich-scenario-"));
  temporary.push(root);
  await run("git", ["init", "-q"], { cwd: root });
  await write(root, "package.json", JSON.stringify({ name: "scenario-host", dependencies: { next: "16.0.0" } }));
  await write(root, ".gitignore", ".vendo\n");
  return root;
}

async function write(root: string, relative: string, text: string): Promise<void> {
  const file = join(root, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

async function commit(root: string, message: string): Promise<void> {
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", message], { cwd: root });
}

/** Extract the first complete JSON array starting at `from` in `text`. */
function jsonArrayAfter(text: string, marker: string): unknown[] {
  const start = text.indexOf("[", text.indexOf(marker));
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "[") depth += 1;
    else if (text[index] === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1)) as unknown[];
    }
  }
  throw new Error(`no JSON array after ${marker}`);
}

/**
 * The fake deterministic model: a static import-tracer. It reads the diff
 * block and the catalog out of the instructions, resolves each route tool to
 * its app-router handler file, and proposes an update for every tool whose
 * handler either appears in the diff or imports a module that does — exactly
 * what a competent model is asked to do, minus the judgment.
 */
function importTracerModel(root: string): { harness: ExtractionHarness; calls: string[] } {
  const calls: string[] = [];
  const harness: ExtractionHarness = {
    id: "import-tracer",
    availability: async () => "the import-tracer fake",
    async run({ instructions }) {
      calls.push(instructions);
      const catalog = jsonArrayAfter(instructions, "Current tool catalog") as Array<{ name: string; binding: string }>;
      const diffBlock = /```diff\n([\s\S]*?)\n```/.exec(instructions)?.[1];
      const changedFiles = diffBlock === undefined
        ? null // full-repo pass: everything is in scope
        : [...diffBlock.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].flatMap((match) => [match[1]!, match[2]!]);
      const affected: string[] = [];
      for (const entry of catalog) {
        const path = / (?:GET|POST|PUT|PATCH|DELETE) (\S+)$/.exec(entry.binding)?.[1];
        if (path === undefined) continue;
        const handler = `app${path}/route.ts`;
        if (changedFiles === null) {
          affected.push(entry.name);
          continue;
        }
        if (changedFiles.includes(handler)) {
          affected.push(entry.name);
          continue;
        }
        let source = "";
        try {
          source = await readFile(join(root, handler), "utf8");
        } catch {
          continue;
        }
        const importsChanged = changedFiles.some((file) => {
          const module = basename(file).replace(/\.[jt]sx?$/, "");
          return source.includes(`/${module}"`) || source.includes(`/${module}'`);
        });
        if (importsChanged) affected.push(entry.name);
      }
      return `\`\`\`json\n${JSON.stringify({
        tools: affected.map((name) => ({ name, description: `Enriched: ${name}.`, risk: "write" })),
        narrative: affected.length === 0
          ? "Reviewed the diff — no live tool's behavior changed."
          : `Updated ${affected.join(", ")} from the diff.`,
      })}\n\`\`\``;
    },
  };
  return { harness, calls };
}

/** One structural sync + enrichment round, exactly the CLI's order. */
async function syncAndEnrich(root: string): Promise<{ result: SyncEnrichmentResult; calls: string[]; notes: string[] }> {
  const vendoDir = join(root, ".vendo");
  const previous = await readPreviousToolsState(vendoDir);
  await vendoSync({ root, out: vendoDir });
  const { harness, calls } = importTracerModel(root);
  const notes: string[] = [];
  const result = await runSyncEnrichment({
    root,
    vendoDir,
    env: {},
    note: (line) => notes.push(line),
    warn: (line) => notes.push(line),
    previous,
    harness,
  });
  return { result, calls, notes };
}

async function toolsFile(root: string): Promise<{ tools: Array<{ name: string; enriched?: boolean }>; watermark?: string }> {
  return JSON.parse(await readFile(join(root, ".vendo", "tools.json"), "utf8"));
}

const ROUTE = "export async function GET() { return Response.json([]); }\n";

describe("labeled diff scenarios (fake deterministic model)", () => {
  it("scenario A — route rename: affected = the renamed tool only", async () => {
    const EXPECTED_AFFECTED = ["host_bills_list"];
    const root = await repo();
    await write(root, "app/api/invoices/route.ts", ROUTE);
    await commit(root, "before");
    const first = await syncAndEnrich(root); // full-mode baseline enrichment
    expect(first.result.status).toBe("enriched");

    // the rename
    await rm(join(root, "app/api/invoices"), { recursive: true });
    await write(root, "app/api/bills/route.ts", ROUTE);
    await commit(root, "rename invoices -> bills");

    const second = await syncAndEnrich(root);
    expect(second.result.status).toBe("enriched");
    expect(second.result.status === "enriched" && second.result.applied).toBe(EXPECTED_AFFECTED.length);
    const file = await toolsFile(root);
    expect(file.tools.map((tool) => tool.name)).toEqual(EXPECTED_AFFECTED);
    expect(file.tools[0]).toMatchObject({ name: "host_bills_list", enriched: true });
    expect(second.notes.join("\n")).toContain("new tools (1): host_bills_list");
  });

  it("scenario B — shared-helper change: affected = every handler importing it, none of whose srcHashes moved", async () => {
    const EXPECTED_AFFECTED = ["host_alpha_list", "host_beta_list"];
    const root = await repo();
    const handler = (helper: string): string =>
      `import { fee } from "../../../lib/${helper}";\nexport async function GET() { return Response.json({ fee }); }\n`;
    await write(root, "lib/pricing.ts", "export const fee = 1;\n");
    await write(root, "app/api/alpha/route.ts", handler("pricing"));
    await write(root, "app/api/beta/route.ts", handler("pricing"));
    await write(root, "app/api/other/route.ts", ROUTE);
    await commit(root, "before");
    const first = await syncAndEnrich(root);
    expect(first.result.status).toBe("enriched");

    // only the helper changes — no handler file (and no srcHash) moves
    await write(root, "lib/pricing.ts", "export const fee = 250; // now in cents!\n");
    await commit(root, "pricing semantics change");

    const second = await syncAndEnrich(root);
    expect(second.result.status).toBe("enriched");
    // the engine consulted the model with the helper diff…
    expect(second.calls[0]).toContain("lib/pricing.ts");
    expect(second.calls[0]).toContain("now in cents!");
    // …and accepted exactly the indirectly affected tools
    expect(second.result.status === "enriched" && second.result.applied).toBe(EXPECTED_AFFECTED.length);
    const file = await toolsFile(root);
    const updated = file.tools
      .filter((tool) => (tool as { description?: string }).description?.startsWith("Enriched") === true)
      .map((tool) => tool.name)
      .sort();
    expect(updated).toEqual(expect.arrayContaining(EXPECTED_AFFECTED));
    expect(second.notes.join("\n")).toContain("changed tools (2): host_alpha_list, host_beta_list");
  });

  it("scenario C — route deletion: affected = nothing; the tool leaves the catalog and the watermark still advances", async () => {
    const EXPECTED_AFFECTED: string[] = [];
    const root = await repo();
    await write(root, "app/api/alpha/route.ts", ROUTE);
    await write(root, "app/api/beta/route.ts", ROUTE);
    await commit(root, "before");
    const first = await syncAndEnrich(root);
    expect(first.result.status).toBe("enriched");
    const beforeWatermark = (await toolsFile(root)).watermark;

    await rm(join(root, "app/api/beta"), { recursive: true });
    await commit(root, "delete beta");

    const second = await syncAndEnrich(root);
    expect(second.result.status).toBe("enriched");
    expect(second.result.status === "enriched" && second.result.applied).toBe(EXPECTED_AFFECTED.length);
    const file = await toolsFile(root);
    expect(file.tools.map((tool) => tool.name)).toEqual(["host_alpha_list"]);
    // TEMP: deleted by judgment-layer lane C2 — this used to assert alpha keeps
    // its earlier enrichment across the structural re-sync (cache stability).
    // That carry lived in vendoSync via `carryEnrichment` + the per-tool
    // `enriched` marker, both deleted; judgments.json carries the AI layer now,
    // and C2 rewrites this pass onto it.
    // the deletion is accounted for: the watermark moves past it
    expect(file.watermark).toBeDefined();
    expect(file.watermark).not.toBe(beforeWatermark);
  });
});
