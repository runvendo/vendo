import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  VENDO_OVERRIDES_FORMAT_V3,
  VENDO_TOOLS_FORMAT_V3,
  overridesFileV3Schema,
  toolsFileV3Schema,
} from "../formats.js";
import { deriveDomains, domainFromToolName } from "./domains.js";
import { vendoSync } from "./index.js";

const run = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryHost(): Promise<{ root: string; out: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-v3-"));
  temporaryDirectories.push(root);
  return { root, out: path.join(root, ".vendo") };
}

async function writeHostFile(root: string, relative: string, source: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

function operation(operationId: string): Record<string, unknown> {
  return { operationId, summary: operationId, responses: { "200": { description: "ok" } } };
}

const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "test", version: "1" },
  paths: { "/api/invoices": { get: operation("listInvoices"), post: operation("createInvoice") } },
}, null, 2) + "\n";

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

const sha256 = (bytes: string): string => `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;

const exists = async (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

// --- realistic legacy fixture files (the v1 four) ---------------------------

const LEGACY_TOOLS = {
  format: "vendo/tools@1",
  tools: [{
    name: "host_listInvoices",
    description: "Use this to read or list invoices (GET /api/invoices).",
    inputSchema: { type: "object", properties: {} },
    risk: "read",
    binding: { kind: "openapi", operationId: "listInvoices", method: "GET", path: "/api/invoices" },
  }],
};

const LEGACY_OVERRIDES = {
  format: "vendo/overrides@1",
  tools: {
    host_createInvoice: { risk: "destructive", critical: true, audience: "end-user" },
    host_listInvoices: { semantics: { "data.total": { kind: "money", unit: "dollars", currency: "EUR" } } },
  },
  remix: { ignoreSlots: ["invoice-card"] },
};

const LEGACY_CAPABILITIES = {
  format: "vendo/capabilities@1",
  tools: [{
    name: "host_invoice_send_flow",
    description: "Create an invoice and email it",
    inputSchema: { type: "object" },
    risk: "write",
    binding: {
      kind: "compound",
      steps: [{ id: "create", tool: "host_createInvoice", args: { amount: "args.amount" } }],
    },
    note: "authored 2026-07-01",
  }],
  briefs: [{ name: "bulk-invoicing", text: "call host_createInvoice per row", tools: ["host_createInvoice"] }],
};

const LEGACY_SEMANTICS = {
  format: "vendo/semantics@1",
  note: "generated",
  tools: {
    host_listInvoices: {
      "data.amountCents": { kind: "money", unit: "cents" },
      // a manual host correction — must survive the fold byte-exactly
      "data.dueAt": { kind: "date", format: "epoch" },
    },
    host_removedTool: { "data.id": { kind: "id", entity: "invoice" } },
  },
  domains: { has: ["invoices", "clients"], hasNot: ["payroll"] },
};

describe("domain derivation (moved from the CLI semantics module)", () => {
  it("derives noun domains from tool names, dropping verbs and plumbing", () => {
    expect(domainFromToolName("host_listAccountTransactions")).toBe("account transactions");
    expect(domainFromToolName("host_getCashflowInsights")).toBe("cashflow insights");
    expect(domainFromToolName("host_auth_create")).toBeUndefined();
    expect(deriveDomains(["host_listInvoices", "host_getInvoices", "host_voice_create"])).toEqual(["invoices"]);
  });
});

describe("vendo sync writes vendo/tools@3", () => {
  it("writes the v3 format with derived domains and per-tool srcHash, deterministically", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await vendoSync({ root, out });

    const file = await readJson(path.join(out, "tools.json"));
    expect(toolsFileV3Schema.safeParse(file).success).toBe(true);
    expect(file.format).toBe(VENDO_TOOLS_FORMAT_V3);
    // domains derived from tool names on first sync
    expect(file.domains).toEqual({ has: ["invoice", "invoices"], hasNot: [] });
    // outside a git repo the watermark is omitted, never guessed
    expect(file.watermark).toBeUndefined();
    // openapi tools carry the spec file's content hash
    const listInvoices = file.tools.find((tool: any) => tool.name === "host_listInvoices");
    expect(listInvoices.srcHash).toBe(sha256(SPEC));
    // and no internal source-path bookkeeping leaks into the file
    expect(listInvoices.srcPath).toBeUndefined();

    // deterministic: same tree, identical bytes
    const first = await fs.readFile(path.join(out, "tools.json"), "utf8");
    await vendoSync({ root, out });
    expect(await fs.readFile(path.join(out, "tools.json"), "utf8")).toBe(first);
  });

  it("hashes route files and server-action modules; omits srcHash where no source file is known", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "package.json", JSON.stringify({ name: "host", dependencies: { next: "16.0.0" } }));
    const route = "export function GET() { return Response.json([]); }\n";
    await writeHostFile(root, "app/api/items/route.ts", route);
    const action = "\"use server\";\nexport async function createItem(name: string) { return { name }; }\n";
    await writeHostFile(root, "app/actions/items.ts", action);
    await vendoSync({ root, out });

    const file = await readJson(path.join(out, "tools.json"));
    const byName = new Map<string, any>(file.tools.map((tool: any) => [tool.name, tool]));
    expect(byName.get("host_items_list")?.srcHash).toBe(sha256(route));
    expect(byName.get("host_create_item")?.srcHash).toBe(sha256(action));
  });

  it("sets the watermark to the repo's HEAD tree hash inside a git repo", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await run("git", ["init", "-q"], { cwd: root });
    await run("git", ["add", "."], { cwd: root });
    await run("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: root });
    const { stdout } = await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: root });

    await vendoSync({ root, out });
    const file = await readJson(path.join(out, "tools.json"));
    expect(file.watermark).toBe(stdout.trim());

    // same tree → identical bytes on a re-run
    const first = await fs.readFile(path.join(out, "tools.json"), "utf8");
    await vendoSync({ root, out });
    expect(await fs.readFile(path.join(out, "tools.json"), "utf8")).toBe(first);
  });

  it("carries per-tool semantics forward from the previous v3 file and drops entries for removed tools", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await vendoSync({ root, out });

    // simulate the CLI's dev-server inference having landed semantics + a curated manifest
    const file = await readJson(path.join(out, "tools.json"));
    for (const tool of file.tools) {
      if (tool.name === "host_listInvoices") tool.semantics = { "data.amountCents": { kind: "money", unit: "cents" } };
      if (tool.name === "host_createInvoice") tool.semantics = { "data.id": { kind: "id", entity: "invoice" } };
    }
    file.domains = { has: ["invoices"], hasNot: ["crypto"] };
    await fs.writeFile(path.join(out, "tools.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");

    // the spec loses createInvoice; a re-sync keeps listInvoices' semantics and the curated manifest
    await writeHostFile(root, "openapi.json", `${JSON.stringify({
      openapi: "3.1.0",
      info: { title: "test", version: "1" },
      paths: { "/api/invoices": { get: operation("listInvoices") } },
    }, null, 2)}\n`);
    await vendoSync({ root, out });
    const next = await readJson(path.join(out, "tools.json"));
    expect(next.tools).toHaveLength(1);
    expect(next.tools[0].semantics).toEqual({ "data.amountCents": { kind: "money", unit: "cents" } });
    expect(next.domains).toEqual({ has: ["invoices"], hasNot: ["crypto"] });
  });

  it("drops carried semantics when a same-named tool's binding changed; an unchanged binding still carries", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await vendoSync({ root, out });

    const file = await readJson(path.join(out, "tools.json"));
    for (const tool of file.tools) {
      tool.semantics = { "data.amountCents": { kind: "money", unit: "cents" } };
    }
    await fs.writeFile(path.join(out, "tools.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");

    // listInvoices keeps its binding; createInvoice keeps its NAME but moves
    // to a different path — its response-shape hints are stale and must drop.
    await writeHostFile(root, "openapi.json", `${JSON.stringify({
      openapi: "3.1.0",
      info: { title: "test", version: "1" },
      paths: {
        "/api/invoices": { get: operation("listInvoices") },
        "/api/billing/invoices": { post: operation("createInvoice") },
      },
    }, null, 2)}\n`);
    await vendoSync({ root, out });
    const next = await readJson(path.join(out, "tools.json"));
    const byName = new Map<string, any>(next.tools.map((tool: any) => [tool.name, tool]));
    expect(byName.get("host_listInvoices")?.semantics).toEqual({ "data.amountCents": { kind: "money", unit: "cents" } });
    expect(byName.get("host_createInvoice")?.semantics).toBeUndefined();
  });

  it("normalizes CRLF to LF before hashing srcHash — cross-platform checkouts agree on the bytes", async () => {
    const lfHost = await temporaryHost();
    const route = "export function GET() {\n  return Response.json([]);\n}\n";
    await writeHostFile(lfHost.root, "app/api/items/route.ts", route);
    await vendoSync(lfHost);
    const lfTool = (await readJson(path.join(lfHost.out, "tools.json"))).tools[0];

    const crlfHost = await temporaryHost();
    await writeHostFile(crlfHost.root, "app/api/items/route.ts", route.replace(/\n/g, "\r\n"));
    await vendoSync(crlfHost);
    const crlfTool = (await readJson(path.join(crlfHost.out, "tools.json"))).tools[0];

    expect(lfTool.srcHash).toBe(sha256(route));
    expect(crlfTool.srcHash).toBe(lfTool.srcHash);
  });

  it("rejects a malformed capabilities.json loudly — its authored compounds/briefs must never silently drop", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await writeHostFile(out, "capabilities.json", "{ not json");
    await expect(vendoSync({ root, out })).rejects.toMatchObject({
      name: "VendoError",
      code: "validation",
      message: expect.stringContaining("malformed capabilities file"),
    });

    const schemaInvalid = await temporaryHost();
    await writeHostFile(schemaInvalid.root, "openapi.json", SPEC);
    await writeHostFile(schemaInvalid.out, "capabilities.json", JSON.stringify({ format: "vendo/capabilities@1", tools: [{ nope: true }] }));
    await expect(vendoSync({ root: schemaInvalid.root, out: schemaInvalid.out })).rejects.toMatchObject({
      name: "VendoError",
      code: "validation",
    });
  });

  it("rejects a malformed v3 overrides.json as loudly as a v1 one", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(out, "overrides.json", JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_x: { rik: "read" } },
    }));
    await expect(vendoSync({ root, out })).rejects.toMatchObject({ name: "VendoError", code: "validation" });
  });
});

describe("vendo sync migrates a legacy .vendo dir on disk", () => {
  async function legacyHost(): Promise<{ root: string; out: string }> {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await writeHostFile(root, ".vendo/tools.json", `${JSON.stringify(LEGACY_TOOLS, null, 2)}\n`);
    await writeHostFile(root, ".vendo/overrides.json", `${JSON.stringify(LEGACY_OVERRIDES, null, 2)}\n`);
    await writeHostFile(root, ".vendo/capabilities.json", `${JSON.stringify(LEGACY_CAPABILITIES, null, 2)}\n`);
    await writeHostFile(root, ".vendo/semantics.json", `${JSON.stringify(LEGACY_SEMANTICS, null, 2)}\n`);
    return { root, out };
  }

  it("folds the legacy four into the v3 pair, preserves every authored value, and deletes the retired files", async () => {
    const { root, out } = await legacyHost();
    const report = await vendoSync({ root, out });

    // one clear migration summary paragraph
    expect(report.migrated).toBeDefined();
    expect(report.migrated).toContain("vendo/tools@3");
    expect(report.migrated).toContain("capabilities.json");
    expect(report.migrated).toContain("semantics.json");

    // retired files are gone — their content now lives in the pair
    expect(await exists(path.join(out, "capabilities.json"))).toBe(false);
    expect(await exists(path.join(out, "semantics.json"))).toBe(false);

    // the machine layer: v3, with semantics.json's entries folded per tool
    const tools = await readJson(path.join(out, "tools.json"));
    expect(toolsFileV3Schema.safeParse(tools).success).toBe(true);
    const listInvoices = tools.tools.find((tool: any) => tool.name === "host_listInvoices");
    expect(listInvoices.semantics).toEqual(LEGACY_SEMANTICS.tools.host_listInvoices);
    // the curated legacy domain manifest survives (host-owned after first sync)
    expect(tools.domains).toEqual(LEGACY_SEMANTICS.domains);

    // the authored layer: byte-exact preservation of every authored value
    const overrides = await readJson(path.join(out, "overrides.json"));
    expect(overridesFileV3Schema.safeParse(overrides).success).toBe(true);
    expect(overrides.format).toBe(VENDO_OVERRIDES_FORMAT_V3);
    expect(JSON.stringify(overrides.tools)).toBe(JSON.stringify(LEGACY_OVERRIDES.tools));
    expect(JSON.stringify(overrides.compounds)).toBe(JSON.stringify(LEGACY_CAPABILITIES.tools));
    expect(JSON.stringify(overrides.briefs)).toBe(JSON.stringify(LEGACY_CAPABILITIES.briefs));
    expect(overrides.remix).toEqual(LEGACY_OVERRIDES.remix);

    // a second sync is not a migration
    const second = await vendoSync({ root, out });
    expect(second.migrated).toBeUndefined();
  });

  it("diffs across the migration boundary: a tool removed since the legacy file still reports", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await writeHostFile(root, ".vendo/tools.json", `${JSON.stringify({
      format: "vendo/tools@1",
      tools: [...LEGACY_TOOLS.tools, {
        name: "host_deleteInvoice",
        description: "Delete an invoice",
        inputSchema: { type: "object" },
        risk: "destructive",
        binding: { kind: "openapi", operationId: "deleteInvoice", method: "DELETE", path: "/api/invoices/{id}" },
      }],
    }, null, 2)}\n`);

    const report = await vendoSync({ root, out });
    expect(report.tools.removed).toContain("host_deleteInvoice");
    expect(report.breaking).toContainEqual({ tool: "host_deleteInvoice", change: "removed" });
  });

  it("half-migrated dir (tools@3 + capabilities.json): compounds/briefs fold into overrides.json and the retired file is deleted", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await vendoSync({ root, out }); // writes the v3 pair-less machine file
    await writeHostFile(root, ".vendo/capabilities.json", `${JSON.stringify(LEGACY_CAPABILITIES, null, 2)}\n`);
    await writeHostFile(root, ".vendo/overrides.json", `${JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_listInvoices: { description: "hand-written" } },
    }, null, 2)}\n`);

    const report = await vendoSync({ root, out });
    expect(report.migrated).toBeDefined();
    expect(await exists(path.join(out, "capabilities.json"))).toBe(false);
    const overrides = await readJson(path.join(out, "overrides.json"));
    expect(overrides.tools.host_listInvoices).toEqual({ description: "hand-written" });
    expect(JSON.stringify(overrides.compounds)).toBe(JSON.stringify(LEGACY_CAPABILITIES.tools));
    expect(JSON.stringify(overrides.briefs)).toBe(JSON.stringify(LEGACY_CAPABILITIES.briefs));
  });

  it("conflicting compounds (overrides@3 AND capabilities.json): warns and leaves capabilities.json on disk", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await writeHostFile(root, ".vendo/capabilities.json", `${JSON.stringify(LEGACY_CAPABILITIES, null, 2)}\n`);
    const authoredCompound = {
      name: "host_other_flow",
      description: "Different authored compound",
      inputSchema: { type: "object" },
      risk: "read",
      binding: { kind: "compound", steps: [{ id: "a", tool: "host_listInvoices" }] },
    };
    await writeHostFile(root, ".vendo/overrides.json", `${JSON.stringify({
      format: "vendo/overrides@3",
      tools: {},
      compounds: [authoredCompound],
    }, null, 2)}\n`);

    const report = await vendoSync({ root, out });
    // entries unique to capabilities.json were NOT folded — so the file must
    // survive for review instead of being deleted (no silent data loss).
    expect(report.warnings.some((warning) => warning.includes("both carry compounds/briefs"))).toBe(true);
    expect(await exists(path.join(out, "capabilities.json"))).toBe(true);
    // the summary claims only what actually folded (briefs, not compounds)
    expect(report.migrated).toContain("the briefs that lived in capabilities.json");
    expect(report.migrated).not.toContain("compounds and briefs that lived");
    const overrides = await readJson(path.join(out, "overrides.json"));
    expect(overrides.compounds.map((tool: any) => tool.name)).toEqual(["host_other_flow"]);
    // the briefs slot had no conflict, so it folded in
    expect(JSON.stringify(overrides.briefs)).toBe(JSON.stringify(LEGACY_CAPABILITIES.briefs));
  });

  it("a MALFORMED semantics.json next to legacy v1 tools survives with a warning; the rest still migrates", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await writeHostFile(root, ".vendo/tools.json", `${JSON.stringify(LEGACY_TOOLS, null, 2)}\n`);
    await writeHostFile(root, ".vendo/semantics.json", "{ not json");

    const report = await vendoSync({ root, out });
    // the tools@1 layout still migrates and announces itself...
    expect(report.migrated).toContain("tools.json (vendo/tools@1)");
    // ...but the unreadable file is never deleted (its content could not be
    // preserved) and the summary does not claim it was retired
    expect(await exists(path.join(out, "semantics.json"))).toBe(true);
    expect(report.migrated).not.toContain("retired");
    expect(report.warnings.some((warning) => warning.includes("malformed retired file"))).toBe(true);
  });

  it("a MALFORMED semantics.json next to an already-v3 tools.json survives and announces no migration", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await vendoSync({ root, out }); // fresh v3 pairless machine file
    await writeHostFile(root, ".vendo/semantics.json", "{ not json");

    const report = await vendoSync({ root, out });
    expect(report.migrated).toBeUndefined();
    expect(await exists(path.join(out, "semantics.json"))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("malformed retired file"))).toBe(true);
  });

  it("half-migrated dir (semantics.json + tools@3): the stale file is deleted without clobbering v3 semantics", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await vendoSync({ root, out });
    const file = await readJson(path.join(out, "tools.json"));
    file.tools.find((tool: any) => tool.name === "host_listInvoices").semantics = {
      "data.amountCents": { kind: "money", unit: "dollars" },
    };
    await fs.writeFile(path.join(out, "tools.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await writeHostFile(root, ".vendo/semantics.json", `${JSON.stringify(LEGACY_SEMANTICS, null, 2)}\n`);

    const report = await vendoSync({ root, out });
    expect(report.migrated).toBeDefined();
    expect(await exists(path.join(out, "semantics.json"))).toBe(false);
    const next = await readJson(path.join(out, "tools.json"));
    // the already-migrated v3 semantics win over the stale legacy file
    expect(next.tools.find((tool: any) => tool.name === "host_listInvoices").semantics)
      .toEqual({ "data.amountCents": { kind: "money", unit: "dollars" } });
  });

  it("extraction failure mid-migration leaves the legacy pair on disk — no delete before the folded tools.json is durable", async () => {
    const { root, out } = await legacyHost();
    // Malformed openapi.json: detect() still sees the file, extract() throws on
    // JSON.parse, so runExtractors rejects after the migration block ran.
    await writeHostFile(root, "openapi.json", "{ not json");

    await expect(vendoSync({ root, out })).rejects.toThrow();

    // The retired legacy files must survive: their folded content only lives in
    // tools.json once writeIfChanged has run, which the throw prevented.
    expect(await exists(path.join(out, "semantics.json"))).toBe(true);
    expect(await exists(path.join(out, "capabilities.json"))).toBe(true);
  });
});
