import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncSemantics } from "./semantics.js";

const TOOLS_FILE = {
  format: "vendo/tools@3",
  tools: [
    {
      name: "host_listInvoices",
      description: "Use this to read or list invoices (GET /api/invoices).",
      inputSchema: {},
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      srcHash: "sha256:abc",
    },
    {
      name: "host_getPayroll",
      description: "",
      inputSchema: {},
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/payroll", argsIn: "query" },
    },
  ],
  watermark: "3d1f2ab90c7e5f6a8b4d0e1c2a3b4c5d6e7f8091",
  domains: { has: ["invoices", "payroll"], hasNot: [] },
};

const INFERRED = {
  tools: {
    host_listInvoices: {
      "data.amountCents": { kind: "money", unit: "cents" },
      "data.dueDate": { kind: "date", format: "iso" },
      "data.status": { kind: "enum", labels: { overdue: "Overdue", paid: "Paid" } },
    },
  },
};

const okFetch: typeof fetch = async () => new Response(JSON.stringify(INFERRED), { status: 200 });
const downFetch: typeof fetch = async () => { throw new Error("refused"); };

async function tempVendoDir(file: unknown = TOOLS_FILE): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "w3-semantics-"));
  await writeFile(join(dir, "tools.json"), `${JSON.stringify(file, null, 2)}\n`);
  return dir;
}

const readTools = async (dir: string) => JSON.parse(await readFile(join(dir, "tools.json"), "utf8"));

describe("syncSemantics (v3: inference lands inside tools.json)", () => {
  it("writes inferred per-tool semantics into tools.json, preserving every other field", async () => {
    const dir = await tempVendoDir();
    const notes: string[] = [];
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: (message) => notes.push(message) });
    const file = await readTools(dir);
    expect(file.format).toBe("vendo/tools@3");
    const listInvoices = file.tools.find((tool: any) => tool.name === "host_listInvoices");
    expect(listInvoices.semantics["data.amountCents"]).toEqual({ kind: "money", unit: "cents" });
    expect(listInvoices.srcHash).toBe("sha256:abc");
    // untouched machine-layer fields survive the enrichment write
    expect(file.watermark).toBe(TOOLS_FILE.watermark);
    expect(file.domains).toEqual(TOOLS_FILE.domains);
    // no inference for the other tool → no semantics key at all
    expect(file.tools.find((tool: any) => tool.name === "host_getPayroll").semantics).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it("inference runs once: existing entries win field-by-field, new fields still land", async () => {
    const dir = await tempVendoDir({
      ...TOOLS_FILE,
      tools: TOOLS_FILE.tools.map((tool) => tool.name === "host_listInvoices"
        ? { ...tool, semantics: { "data.amountCents": { kind: "money", unit: "dollars" } } }
        : tool),
    });
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: () => {} });
    const listInvoices = (await readTools(dir)).tools.find((tool: any) => tool.name === "host_listInvoices");
    // the host's manual correction is never overwritten...
    expect(listInvoices.semantics["data.amountCents"]).toEqual({ kind: "money", unit: "dollars" });
    // ...while fresh inference still lands for untouched fields
    expect(listInvoices.semantics["data.dueDate"]).toEqual({ kind: "date", format: "iso" });
  });

  it("keeps the file byte-identical and notes when the dev server is unreachable", async () => {
    const dir = await tempVendoDir();
    const before = await readFile(join(dir, "tools.json"), "utf8");
    const notes: string[] = [];
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: downFetch, note: (message) => notes.push(message) });
    expect(await readFile(join(dir, "tools.json"), "utf8")).toBe(before);
    expect(notes.some((message) => message.includes("dev server not reachable"))).toBe(true);
  });

  it("no-ops on a non-v3 tools.json (the sync engine rewrites the dir first)", async () => {
    const dir = await tempVendoDir({ format: "vendo/tools@1", tools: TOOLS_FILE.tools });
    const before = await readFile(join(dir, "tools.json"), "utf8");
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: () => {} });
    expect(await readFile(join(dir, "tools.json"), "utf8")).toBe(before);
  });

  it("never copies overrides.json annotations into tools.json — they stay authored-only", async () => {
    const dir = await tempVendoDir();
    await writeFile(join(dir, "overrides.json"), JSON.stringify({
      format: "vendo/overrides@3",
      tools: {
        host_getPayroll: { semantics: { "data.salaryCents": { kind: "money", unit: "cents" } } },
      },
    }));
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: () => {} });
    const payroll = (await readTools(dir)).tools.find((tool: any) => tool.name === "host_getPayroll");
    expect(payroll.semantics).toBeUndefined();
  });

  it("drops malformed inference entries instead of poisoning the file", async () => {
    const dir = await tempVendoDir();
    const badFetch: typeof fetch = async () => new Response(JSON.stringify({
      tools: {
        host_listInvoices: {
          "data.amountCents": { kind: "money", unit: "cents" },
          "data.bogus": { kind: "money" },
        },
      },
    }), { status: 200 });
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: badFetch, note: () => {} });
    const listInvoices = (await readTools(dir)).tools.find((tool: any) => tool.name === "host_listInvoices");
    expect(listInvoices.semantics).toEqual({ "data.amountCents": { kind: "money", unit: "cents" } });
  });
});
