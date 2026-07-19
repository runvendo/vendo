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

  it("surfaces a bare composioConnector's full-catalog tools, unbounded, from the registry search path", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      // Unscoped — no toolkit_slug in the request — spanning toolkits the
      // host never named explicitly, the way a bare composioConnector() sees
      // the whole Composio catalog (docs.composio.dev/toolkits).
      res.end(JSON.stringify({
        items: [
          { slug: "SEND_EMAIL", toolkit_slug: "gmail", description: "Send an email", input_parameters: {} },
          { slug: "CREATE_ISSUE", toolkit_slug: "linear", description: "Create a tracking issue", input_parameters: {} },
          { slug: "CREATE_PAGE", toolkit_slug: "notion", description: "Create a notion page", input_parameters: {} },
        ],
      }));
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

    // Bare: no `apps` key at all — the connector under test for decision 7
    // ("a bare composio() exposes the full Composio catalog; apps: narrows").
    const registry = createActions({
      connectors: [composioConnector({ apiKey: "secret", baseUrl: `http://127.0.0.1:${port}` })],
    });

    // The actions layer itself applies no cap — descriptors() returns the
    // whole unscoped catalog. Bounding to a prompt-safe loadout is the
    // agent layer's job (packages/agent/src/tool-search.ts
    // computeInitialLoadout / DEFAULT_MAX_INITIAL_TOOLS), not the registry's.
    expect((await registry.descriptors()).map((d) => d.name).sort()).toEqual([
      "gmail_SEND_EMAIL",
      "linear_CREATE_ISSUE",
      "notion_CREATE_PAGE",
    ]);

    // A toolkit the host never listed in `apps` (there is no `apps` at all)
    // is still discoverable through vendo_tools_search's registry seam.
    const matches = await registry.search("create a tracking issue");
    expect(matches[0]?.name).toBe("linear_CREATE_ISSUE");
  });
});
