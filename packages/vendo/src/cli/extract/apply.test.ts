import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExtractApply } from "./apply.js";
import { telemetryCapture } from "../telemetry.test-util.js";
import { composeDelegatedInstructions, EXTRACTION_DRAFT_JSON_SCHEMA } from "./delegate.js";
import type { Output } from "../shared.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const TOOLS = [
  { name: "host_invoices_list", description: "GET /api/invoices", risk: "read" as const, method: "GET", path: "/api/invoices" },
  { name: "host_invoices_create", description: "POST /api/invoices", risk: "write" as const, method: "POST", path: "/api/invoices" },
  { name: "host_admin_unclassified", description: "Route /api/admin could not be classified", risk: "destructive" as const, disabled: true },
];

async function fixture(brief?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-extract-apply-"));
  cleanup.push(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: "vendo/tools@1", tools: TOOLS }));
  await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify(
    { format: "vendo/overrides@1", tools: {}, remix: { ignoreSlots: [] } },
  ));
  await writeFile(join(root, ".vendo", "brief.md"),
    `${brief ?? "Describe this product, its users, and the jobs the agent should help them complete."}\n`);
  return root;
}

async function draftFile(root: string, content: unknown): Promise<string> {
  const path = join(root, "draft.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

function output(): { output: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (message) => logs.push(message), error: (message) => errors.push(message) }, logs, errors };
}

const okSync = () => vi.fn(async () => ({ warnings: [] }));

describe("vendo extract --apply (the delegation surface)", () => {
  it("applies a valid draft through the guards, re-syncs, and prints the init summary", async () => {
    const root = await fixture();
    const draft = await draftFile(root, {
      brief: "Maple is a consumer bank; users check balances and pay bills.",
      tools: [
        { name: "host_invoices_list", description: "List invoices, filterable by status." },
        { name: "host_invoices_create", description: "Create and send an invoice.", risk: "destructive", critical: true },
        { name: "host_admin_unclassified", description: "Reset all demo data.", disabled: false, risk: "destructive", reasoning: "handler truncates tables" },
      ],
      missedSurfaces: ["/api/webhooks — event ingestion, not extracted"],
    });
    const sink = output();
    const sync = okSync();
    expect(await runExtractApply({ targetDir: root, apply: draft, output: sink.output, sync })).toBe(0);

    const overrides = JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8")) as
      { tools: Record<string, Record<string, unknown>> };
    expect(overrides.tools["host_invoices_list"]).toEqual({ description: "List invoices, filterable by status." });
    expect(overrides.tools["host_invoices_create"]).toMatchObject({ risk: "destructive", critical: true });
    expect(overrides.tools["host_admin_unclassified"]).toMatchObject({ disabled: false, risk: "destructive" });
    expect(await readFile(join(root, ".vendo", "brief.md"), "utf8")).toContain("consumer bank");

    expect(sync).toHaveBeenCalledWith({ root, out: join(root, ".vendo") });
    const logs = sink.logs.join("\n");
    expect(logs).toContain("AI polish applied: 3 descriptions · 1 risk raises · 1 critical marks · 1 tools woken · brief drafted");
    expect(logs).toContain("missed surface (not extracted yet): /api/webhooks");
  });

  it("surfaces guard refusals honestly and still exits 0 (the guards worked)", async () => {
    const root = await fixture();
    const draft = await draftFile(root, {
      brief: "b",
      tools: [
        { name: "invented_tool", description: "nope" },
        { name: "host_invoices_create", description: "Create an invoice.", risk: "read" },
      ],
    });
    const sink = output();
    expect(await runExtractApply({ targetDir: root, apply: draft, output: sink.output, sync: okSync() })).toBe(0);
    const errors = sink.errors.join("\n");
    expect(errors).toContain("refused: invented_tool: not an extracted tool");
    expect(errors).toContain("refused: host_invoices_create: risk downgrade write→read refused");
    const overrides = JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8")) as
      { tools: Record<string, Record<string, unknown>> };
    expect(overrides.tools["invented_tool"]).toBeUndefined();
  });

  it("keeps a hand-written brief unless --force, exactly like init", async () => {
    const root = await fixture("The human already wrote this brief.");
    const draft = await draftFile(root, { brief: "Model brief.", tools: [] });
    const sink = output();
    expect(await runExtractApply({ targetDir: root, apply: draft, output: sink.output, sync: okSync() })).toBe(0);
    expect(await readFile(join(root, ".vendo", "brief.md"), "utf8")).toContain("human already wrote");

    expect(await runExtractApply({ targetDir: root, apply: draft, force: true, output: sink.output, sync: okSync() })).toBe(0);
    expect(await readFile(join(root, ".vendo", "brief.md"), "utf8")).toContain("Model brief.");
  });

  it("exits non-zero with an honest message on a schema-invalid draft", async () => {
    const root = await fixture();
    const draft = await draftFile(root, { brief: "", tools: [{ name: "t" }] });
    const sink = output();
    expect(await runExtractApply({ targetDir: root, apply: draft, output: sink.output, sync: okSync() })).toBe(1);
    expect(sink.errors.join("\n")).toContain("Draft rejected");
    expect(sink.errors.join("\n")).toContain("aiPolish.draftSchema");
  });

  it("exits non-zero on unparseable JSON, a missing draft file, and a missing tools.json", async () => {
    const root = await fixture();
    const sink = output();

    const garbled = await draftFile(root, "not json at all");
    expect(await runExtractApply({ targetDir: root, apply: garbled, output: sink.output, sync: okSync() })).toBe(1);
    expect(sink.errors.join("\n")).toContain("Draft rejected");

    expect(await runExtractApply({ targetDir: root, apply: join(root, "nope.json"), output: sink.output, sync: okSync() })).toBe(1);
    expect(sink.errors.join("\n")).toContain("Draft file not found");

    // Non-ENOENT read failures (a directory, permissions) exit honestly too
    // instead of escaping as an uncaught crash (Greptile P1).
    expect(await runExtractApply({ targetDir: root, apply: root, output: sink.output, sync: okSync() })).toBe(1);
    expect(sink.errors.join("\n")).toContain("Draft file unreadable");

    const bare = await mkdtemp(join(tmpdir(), "vendo-extract-apply-bare-"));
    cleanup.push(bare);
    const draft = await draftFile(bare, { brief: "b", tools: [] });
    expect(await runExtractApply({ targetDir: bare, apply: draft, output: sink.output, sync: okSync() })).toBe(1);
    expect(sink.errors.join("\n")).toContain("run `vendo init` first");
  });

  it("exits non-zero honestly when a hand-edited overrides.json cannot be parsed (Devin)", async () => {
    const root = await fixture();
    await writeFile(join(root, ".vendo", "overrides.json"), '{"format": "vendo/overrides@1", "tools": {');
    const draft = await draftFile(root, {
      brief: "b",
      tools: [{ name: "host_invoices_list", description: "List invoices." }],
    });
    const sink = output();
    expect(await runExtractApply({ targetDir: root, apply: draft, output: sink.output, sync: okSync() })).toBe(1);
    expect(sink.errors.join("\n")).toContain("Could not apply the draft");
    expect(sink.errors.join("\n")).toContain("overrides.json");
  });

  it("reports a failed re-sync as non-zero after applying (overrides landed, tools.json is stale)", async () => {
    const root = await fixture();
    const draft = await draftFile(root, {
      brief: "b",
      tools: [{ name: "host_invoices_list", description: "List invoices." }],
    });
    const sink = output();
    const sync = vi.fn(async () => { throw new Error("scan blew up"); });
    expect(await runExtractApply({ targetDir: root, apply: draft, output: sink.output, sync })).toBe(1);
    expect(sink.errors.join("\n")).toContain("re-sync failed (scan blew up)");
    const overrides = JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8")) as
      { tools: Record<string, Record<string, unknown>> };
    expect(overrides.tools["host_invoices_list"]).toEqual({ description: "List invoices." });
  });
});

describe("the delegation contract", () => {
  it("composes one-shot instructions carrying the static facts, the guard rules, and the apply command", () => {
    const instructions = composeDelegatedInstructions(TOOLS, "maple");
    expect(instructions).toContain("maple");
    expect(instructions).toContain("host_invoices_list");
    expect(instructions).toContain('"disabled": true');
    expect(instructions).toContain("never lower");
    expect(instructions).toContain('"brief": string');
    expect(instructions).toContain("vendo extract --apply");
  });

  it("publishes a draft schema whose shape matches parseDraft's expectations", () => {
    const schema = EXTRACTION_DRAFT_JSON_SCHEMA as {
      required: string[];
      properties: { tools: { items: { required: string[]; properties: Record<string, unknown> } } };
    };
    expect(schema.required).toEqual(["brief", "tools"]);
    expect(schema.properties.tools.items.required).toEqual(["name", "description"]);
    expect(Object.keys(schema.properties.tools.items.properties)).toEqual(
      ["name", "description", "risk", "critical", "disabled", "reasoning"],
    );
  });
});

describe("extract telemetry", () => {
  it("tracks command_run extract and extract_completed with the result metrics", async () => {
    const root = await fixture();
    // The fixture has no package.json — write one so framework + versions resolve.
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "^15.3.1", zod: "~3.24.0" },
    }));
    const draft = await draftFile(root, {
      brief: "Maple is a consumer bank.",
      tools: [{ name: "host_invoices_list", description: "List invoices, filterable by status." }],
    });
    const tele = await telemetryCapture();
    cleanup.push(tele.home);
    expect(await runExtractApply({ targetDir: root, apply: draft, output: output().output, sync: okSync(), telemetry: tele.telemetry })).toBe(0);
    expect(tele.event("command_run").properties).toMatchObject({ command: "extract", ok: true });
    expect(tele.event("extract_completed").properties).toMatchObject({
      framework: "next",
      method: "none", // fixture tools carry no route bindings
      routeCount: 0,
      toolCount: 3,
      ok: true,
      frameworkVersion: "15.3.1",
      zodVersion: "3.24.0",
    });
    expect(typeof tele.event("extract_completed").properties.durationMs).toBe("number");
  });

  it("tracks a failed run with the step that failed, and no extract_completed", async () => {
    const root = await fixture();
    const tele = await telemetryCapture();
    cleanup.push(tele.home);
    expect(await runExtractApply({
      targetDir: root,
      apply: join(root, "missing-draft.json"),
      output: output().output,
      sync: okSync(),
      telemetry: tele.telemetry,
    })).toBe(1);
    expect(tele.event("command_run").properties).toMatchObject({ command: "extract", ok: false, failedStep: "draft" });
    expect(tele.events().some((entry) => entry.event === "extract_completed")).toBe(false);
  });
});
