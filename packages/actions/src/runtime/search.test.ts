import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolDescriptor } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { composioConnector } from "../connectors/composio.js";
import { createActions, type ExtractedTool } from "../index.js";
import { searchToolDescriptors } from "./search.js";

function descriptor(name: string, description: string, risk: ToolDescriptor["risk"] = "read"): ToolDescriptor {
  return { name, description, inputSchema: { type: "object" }, risk };
}

describe("searchToolDescriptors (pure ranking)", () => {
  const surface: ToolDescriptor[] = [
    descriptor("host_invoices_create", "Create a new invoice for a customer", "write"),
    descriptor("host_invoices_list", "List invoices"),
    descriptor("host_customers_list", "List customers"),
    descriptor("host_reports_export", "Export a financial report as CSV", "read"),
  ];

  it("returns an empty list for a blank or symbol-only query", () => {
    expect(searchToolDescriptors(surface, "")).toEqual([]);
    expect(searchToolDescriptors(surface, "   ---  ")).toEqual([]);
  });

  it("ranks a whole-name intent match above partial matches", () => {
    const matches = searchToolDescriptors(surface, "create invoice");
    expect(matches[0]?.name).toBe("host_invoices_create");
    // The list tool shares the "invoice" token but not "create" → strictly lower.
    const listScore = matches.find((m) => m.name === "host_invoices_list")?.score ?? 0;
    expect(matches[0]!.score).toBeGreaterThan(listScore);
  });

  it("matches on description tokens when the name does not carry the intent", () => {
    const matches = searchToolDescriptors(surface, "csv");
    expect(matches.map((m) => m.name)).toContain("host_reports_export");
  });

  it("is deterministic and breaks ties by name ascending", () => {
    const tie = [descriptor("host_b_list", "list things"), descriptor("host_a_list", "list things")];
    const first = searchToolDescriptors(tie, "list");
    const second = searchToolDescriptors(tie, "list");
    expect(first).toEqual(second);
    expect(first.map((m) => m.name)).toEqual(["host_a_list", "host_b_list"]);
  });

  it("clamps the limit into [1, 50]", () => {
    expect(searchToolDescriptors(surface, "list", { limit: 0 })).toHaveLength(1);
    expect(searchToolDescriptors(surface, "list", { limit: 999 }).length).toBeLessThanOrEqual(50);
  });
});

describe("ActionsRegistry.search (over the merged surface)", () => {
  it("excludes tools disabled via overrides from the loadable results", async () => {
    const tools: ExtractedTool[] = [
      { ...descriptor("host_secret_wipe", "Wipe all data", "destructive"), binding: { kind: "route", method: "POST", path: "/wipe", argsIn: "body" } },
      { ...descriptor("host_data_list", "List data"), binding: { kind: "route", method: "GET", path: "/data", argsIn: "query" } },
    ];
    // With no override, the destructive tool IS searchable.
    const registry = createActions({ tools });
    expect((await registry.search("wipe data")).map((m) => m.name)).toContain("host_secret_wipe");

    // A disabled tool must be hidden from search entirely (never a loadable hit).
    const withDisabled = createActions({ tools: [{ ...tools[0]!, disabled: true }, tools[1]!] });
    const results = await withDisabled.search("wipe data");
    expect(results.map((m) => m.name)).not.toContain("host_secret_wipe");
  });

  it("ranks the intended tool first within a 300+ tool host surface", async () => {
    const tools: ExtractedTool[] = [];
    for (let index = 0; index < 320; index += 1) {
      tools.push({
        ...descriptor(`host_widget_${index}_get`, `Fetch widget ${index} details`),
        binding: { kind: "route", method: "GET", path: `/widgets/${index}`, argsIn: "query" },
      });
    }
    // The single needle: a payout refund tool buried in the noise.
    tools.push({
      ...descriptor("host_payouts_refund", "Refund a customer payout", "destructive"),
      binding: { kind: "route", method: "POST", path: "/payouts/refund", argsIn: "body" },
    });
    const registry = createActions({ tools });
    expect(await registry.descriptors()).toHaveLength(321);

    const matches = await registry.search("refund a payout", { limit: 5 });
    expect(matches[0]?.name).toBe("host_payouts_refund");
    expect(matches[0]?.risk).toBe("destructive");
  });

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("discovers a bare composioConnector's toolkits by intent: index-ranked, expanded on demand", async () => {
    // Connection-scoped tool loading (spec 2026-07-20): a bare connector no
    // longer exposes the full catalog eagerly. The registry search ranks the
    // toolkit-level discovery index, expands the matching toolkit, and only
    // THEN returns its real tools — annotated with the connect hint.
    const toolFetches: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/v3/auth_configs") {
        res.end(JSON.stringify({
          items: [
            { id: "ac_gmail", toolkit: { slug: "gmail" }, status: "ENABLED" },
            { id: "ac_linear", toolkit: { slug: "linear" }, status: "ENABLED" },
            { id: "ac_notion", toolkit: { slug: "notion" }, status: "ENABLED" },
          ],
          total_items: 3,
          next_cursor: null,
        }));
        return;
      }
      const slugMatch = /^\/api\/v3\/toolkits\/([^/]+)$/.exec(url.pathname);
      if (slugMatch) {
        const slug = slugMatch[1]!;
        const blurbs: Record<string, string> = {
          gmail: "Send and read email",
          linear: "Create and track engineering issues",
          notion: "Create pages and databases",
        };
        res.end(JSON.stringify({ slug, name: slug, meta: { description: blurbs[slug] ?? "" } }));
        return;
      }
      if (url.pathname === "/api/v3/tools") {
        const toolkit = url.searchParams.get("toolkit_slug")!;
        toolFetches.push(toolkit);
        const tools: Record<string, { slug: string; description: string }> = {
          gmail: { slug: "SEND_EMAIL", description: "Send an email" },
          linear: { slug: "CREATE_ISSUE", description: "Create a tracking issue" },
          notion: { slug: "CREATE_PAGE", description: "Create a notion page" },
        };
        const tool = tools[toolkit]!;
        res.end(JSON.stringify({ items: [{ slug: tool.slug, toolkit_slug: toolkit, description: tool.description, input_parameters: {} }] }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    closers.push(async () => {
      server.close();
      server.closeAllConnections();
    });

    const registry = createActions({
      connectors: [composioConnector({ apiKey: "secret", baseUrl: `http://127.0.0.1:${port}` })],
    });

    // Nothing loads eagerly — the boot surface has no connector tools.
    expect(await registry.descriptors()).toEqual([]);

    // Intent-driven discovery: the linear index entry matches, expands, and
    // its real tool comes back annotated; unrelated toolkits stay unloaded.
    const matches = await registry.search("create a tracking issue for engineering");
    expect(matches[0]?.name).toBe("linear_CREATE_ISSUE");
    expect(matches[0]?.description).toMatch(/connect/i);
    // linear expanded; "create" also overlaps notion's blurb (bounded fan-out
    // is fine) — but gmail, with zero word overlap, must stay unloaded.
    expect(toolFetches).toContain("linear");
    expect(toolFetches).not.toContain("gmail");
  });
});
