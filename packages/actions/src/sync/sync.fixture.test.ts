import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { vendoSync } from "./index.js";

const fixtureRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../../fixtures/host-app");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("vendoSync host fixture", () => {
  it("unions OpenAPI and fail-closed route extraction, captures pins, and is idempotent", async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-fixture-"));
    temporaryDirectories.push(out);

    const first = await vendoSync({ root: fixtureRoot, out });
    const firstBytes = await fs.readFile(path.join(out, "tools.json"), "utf8");
    const firstCatalogBytes = await fs.readFile(path.join(out, "catalog.json"), "utf8");
    const toolsFile = JSON.parse(firstBytes) as { format: string; tools: Array<Record<string, any>> };
    const byName = new Map(toolsFile.tools.map((tool) => [tool.name, tool]));

    expect(toolsFile.format).toBe("vendo/tools@1");
    expect(Object.fromEntries([
      "host_listInvoices",
      "host_createInvoice",
      "host_updateInvoice",
      "host_deleteInvoice",
      "host_sendInvoice",
      "host_downloadInvoicesArchive",
      "host_getInvoice",
      "host_listCustomers",
    ].map((name) => [name, byName.get(name)?.risk]))).toEqual({
      host_listInvoices: "read",
      host_createInvoice: "write",
      host_updateInvoice: "write",
      host_deleteInvoice: "destructive",
      host_sendInvoice: "destructive",
      host_downloadInvoicesArchive: "destructive",
      host_getInvoice: "read",
      host_listCustomers: "read",
    });
    expect(byName.get("host_login_create")?.risk).toBe("write");
    expect(byName.get("host_ping_list")?.risk).toBe("write");
    expect(byName.get("host_listCustomers")?.binding).toMatchObject({ kind: "openapi", path: "/api/customers" });
    // Alias resolution: the summary route only re-exports GET through @fixture/* (not in openapi.json).
    expect(byName.get("host_reports_summary_list")).toMatchObject({
      risk: "write",
      binding: { kind: "route", method: "GET", path: "/api/reports/summary", argsIn: "query" },
    });
    expect(toolsFile.tools.some((tool) => String(tool.binding?.path).startsWith("/api/vendo"))).toBe(false);
    expect(byName.get("host_export_data_unclassified")).toMatchObject({
      disabled: true,
      risk: "destructive",
      binding: { kind: "route", method: "POST", path: "/api/export-data", argsIn: "body" },
    });
    expect(byName.get("host_export_data_unclassified")?.note).toContain("enable only after review");
    expect(toolsFile.tools.every((tool) => /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name))).toBe(true);

    expect(first.pins).toEqual({
      captured: ["AliasedCard", "BarrelCard", "InvoiceCard", "NamespaceCard"],
      drifted: [],
    });
    expect(first.unresolvedPins).toEqual([]);
    const invoicePin = JSON.parse(await fs.readFile(path.join(out, "remixable", "InvoiceCard.json"), "utf8"));
    expect(invoicePin).toMatchObject({ slot: "InvoiceCard", exportable: true });
    expect(invoicePin.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await fs.readFile(path.join(out, "remixable", "AliasedCard.json"), "utf8")).toContain("Aliased import");
    expect(await fs.readFile(path.join(out, "remixable", "BarrelCard.json"), "utf8")).toContain("Barrel chain");
    expect(await fs.readFile(path.join(out, "remixable", "NamespaceCard.json"), "utf8")).toContain("Namespace import");
    await expect(fs.access(path.join(out, "remixable", "StatusBadge.json"))).rejects.toThrow();
    expect(first.tools.added.length).toBe(toolsFile.tools.length);
    expect(first.breaking).toEqual([]);
    expect(Array.isArray(first.warnings)).toBe(true);

    const second = await vendoSync({ root: fixtureRoot, out });
    expect(await fs.readFile(path.join(out, "tools.json"), "utf8")).toBe(firstBytes);
    expect(await fs.readFile(path.join(out, "catalog.json"), "utf8")).toBe(firstCatalogBytes);
    expect(second.tools).toEqual({ added: [], removed: [], changed: [] });
    expect(second.breaking).toEqual([]);
    expect(second.pins).toEqual({ captured: [], drifted: [] });
    expect(second.unresolvedPins).toEqual([]);
  });
});
