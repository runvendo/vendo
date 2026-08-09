import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VENDO_TOOLS_FORMAT, toolsFileSchema } from "../../src/formats.js";
import { vendoSync } from "../../src/sync/index.js";

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

describe("vendo sync writes vendo/tools@3", () => {
  it("writes the v3 format with per-tool srcHash, deterministically", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await vendoSync({ root, out });

    const file = await readJson(path.join(out, "tools.json"));
    expect(toolsFileSchema.safeParse(file).success).toBe(true);
    expect(file.format).toBe(VENDO_TOOLS_FORMAT);
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

  it("carries per-tool semantics forward from the previous v3 file and drops entries for removed tools", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await vendoSync({ root, out });

    // simulate the CLI's dev-server inference having landed semantics
    const file = await readJson(path.join(out, "tools.json"));
    for (const tool of file.tools) {
      if (tool.name === "host_listInvoices") tool.semantics = { "data.amountCents": { kind: "money", unit: "cents" } };
      if (tool.name === "host_createInvoice") tool.semantics = { "data.id": { kind: "id", entity: "invoice" } };
    }
    await fs.writeFile(path.join(out, "tools.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");

    // the spec loses createInvoice; a re-sync keeps listInvoices' semantics
    await writeHostFile(root, "openapi.json", `${JSON.stringify({
      openapi: "3.1.0",
      info: { title: "test", version: "1" },
      paths: { "/api/invoices": { get: operation("listInvoices") } },
    }, null, 2)}\n`);
    await vendoSync({ root, out });
    const next = await readJson(path.join(out, "tools.json"));
    expect(next.tools).toHaveLength(1);
    expect(next.tools[0].semantics).toEqual({ "data.amountCents": { kind: "money", unit: "cents" } });
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

  it("rejects a malformed overrides.json loudly", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(out, "overrides.json", JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_x: { rik: "read" } },
    }));
    await expect(vendoSync({ root, out })).rejects.toMatchObject({ name: "VendoError", code: "validation" });
  });
});

describe("vendo sync diffs against the tools.json already on disk", () => {
  it("a tool removed since the previous file still reports as removed and breaking", async () => {
    const { root, out } = await temporaryHost();
    await writeHostFile(root, "openapi.json", SPEC);
    await writeHostFile(root, ".vendo/tools.json", `${JSON.stringify({
      format: VENDO_TOOLS_FORMAT,
      tools: [{
        name: "host_listInvoices",
        description: "Use this to read or list invoices (GET /api/invoices).",
        inputSchema: { type: "object", properties: {} },
        risk: "read",
        binding: { kind: "openapi", operationId: "listInvoices", method: "GET", path: "/api/invoices" },
      }, {
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
});
