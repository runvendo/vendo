import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveDomains, domainFromToolName, syncSemantics } from "./semantics.js";

const TOOLS_FILE = {
  format: "vendo/tools@1",
  tools: [
    {
      name: "host_listInvoices",
      description: "Use this to read or list invoices (GET /api/invoices).",
      inputSchema: {},
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
    },
    {
      name: "host_getPayroll",
      description: "",
      inputSchema: {},
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/payroll", argsIn: "query" },
    },
  ],
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

async function tempVendoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "w3-semantics-"));
  await writeFile(join(dir, "tools.json"), JSON.stringify(TOOLS_FILE));
  return dir;
}

const readSemantics = async (dir: string) => JSON.parse(await readFile(join(dir, "semantics.json"), "utf8"));

describe("domain derivation", () => {
  it("derives noun domains from tool names, dropping verbs and plumbing", () => {
    expect(domainFromToolName("host_listAccountTransactions")).toBe("account transactions");
    expect(domainFromToolName("host_getCashflowInsights")).toBe("cashflow insights");
    expect(domainFromToolName("host_auth_create")).toBeUndefined();
    expect(deriveDomains(["host_listInvoices", "host_getInvoices", "host_voice_create"])).toEqual(["invoices"]);
  });
});

describe("syncSemantics", () => {
  it("writes inferred semantics + a derived domain manifest on first sync", async () => {
    const dir = await tempVendoDir();
    const notes: string[] = [];
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: (message) => notes.push(message) });
    const file = await readSemantics(dir);
    expect(file.format).toBe("vendo/semantics@1");
    expect(file.tools.host_listInvoices["data.amountCents"]).toEqual({ kind: "money", unit: "cents" });
    expect(file.domains.has).toEqual(["invoices", "payroll"]);
    expect(file.domains.hasNot).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("preserves host edits: corrected fields and a curated domain manifest survive re-sync", async () => {
    const dir = await tempVendoDir();
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: () => {} });
    const edited = await readSemantics(dir);
    edited.tools.host_listInvoices["data.amountCents"] = { kind: "money", unit: "dollars" };
    edited.domains = { has: ["invoices"], hasNot: ["payroll", "crypto"] };
    await writeFile(join(dir, "semantics.json"), JSON.stringify(edited, null, 2));

    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: () => {} });
    const file = await readSemantics(dir);
    expect(file.tools.host_listInvoices["data.amountCents"]).toEqual({ kind: "money", unit: "dollars" });
    expect(file.domains).toEqual({ has: ["invoices"], hasNot: ["payroll", "crypto"] });
    // Fresh inference still lands for fields the host did not touch.
    expect(file.tools.host_listInvoices["data.dueDate"]).toEqual({ kind: "date", format: "iso" });
  });

  it("host annotations in overrides.json win over inference and the existing file", async () => {
    const dir = await tempVendoDir();
    await writeFile(join(dir, "overrides.json"), JSON.stringify({
      format: "vendo/overrides@1",
      tools: {
        host_listInvoices: { semantics: { "data.amountCents": { kind: "money", unit: "cents", currency: "EUR" } } },
      },
    }));
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: () => {} });
    const file = await readSemantics(dir);
    expect(file.tools.host_listInvoices["data.amountCents"]).toEqual({ kind: "money", unit: "cents", currency: "EUR" });
  });

  it("keeps the existing file's entries and notes when the dev server is unreachable", async () => {
    const dir = await tempVendoDir();
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: () => {} });
    const notes: string[] = [];
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: downFetch, note: (message) => notes.push(message) });
    const file = await readSemantics(dir);
    expect(file.tools.host_listInvoices["data.amountCents"]).toEqual({ kind: "money", unit: "cents" });
    expect(notes.some((message) => message.includes("dev server not reachable"))).toBe(true);
  });

  it("drops semantics for tools that no longer exist", async () => {
    const dir = await tempVendoDir();
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: okFetch, note: () => {} });
    await writeFile(join(dir, "tools.json"), JSON.stringify({
      ...TOOLS_FILE,
      tools: TOOLS_FILE.tools.filter((tool) => tool.name !== "host_listInvoices"),
    }));
    await syncSemantics({ vendoDir: dir, url: "http://dev.test/api/vendo", fetchImpl: downFetch, note: () => {} });
    const file = await readSemantics(dir);
    expect(file.tools.host_listInvoices).toBeUndefined();
  });
});
