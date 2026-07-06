import { afterEach, describe, expect, it, vi } from "vitest";
import { replayRegistry } from "@vendoai/shell";
import type { GeneratedPayload, HostToolDefinition } from "@vendoai/core";
import { __voiceTesting } from "./voice.js";

const { createVoiceInternals } = __voiceTesting;
const disposers: Array<() => void> = [];

const readAccounts: HostToolDefinition = {
  name: "list_accounts",
  description: "List the user's accounts",
  inputSchema: { type: "object", properties: {}, required: [] },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  http: { method: "get", path: "/api/accounts", params: [], hasBody: false },
};

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
});

function trackedInternals(options?: Parameters<typeof createVoiceInternals>[0]) {
  const internals = createVoiceInternals(options);
  disposers.push(() => internals.dispose());
  return internals;
}

describe("createVendoVoice internals", () => {
  it("builds a data-bound table payload when source matches the replay cache", () => {
    const internals = trackedInternals();
    const raw = { ok: true, data: { rows: [{ merchant: "Cafe", amount: 42 }] } };
    disposers.push(replayRegistry.register("listTransactionsForPackagedVoice", async () => raw));
    internals.recordResult("listTransactionsForPackagedVoice", { limit: 10 }, raw);

    const node = internals.tableView({
      title: "Recent spend",
      columns: [
        { key: "merchant", label: "Merchant" },
        { key: "amount", label: "Amount" },
      ],
      rows: raw.data.rows,
      source: {
        tool: "listTransactionsForPackagedVoice",
        input: { limit: 10 },
        rowsPath: "/data/rows",
      },
    });

    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries).toEqual([
      { path: "/source", tool: "listTransactionsForPackagedVoice", input: { limit: 10 } },
    ]);
    const table = payload.nodes.find((n) => n.component === "Table");
    expect(table?.props?.rows).toEqual({ $path: "/source/data/rows" });
    expect(payload.data).toEqual({ source: raw });
  });

  it("renders show_money_flow as a prewired Sankey generated view", () => {
    const internals = trackedInternals();
    const node = internals.moneyFlowView({
      title: "Where money went",
      nodes: [
        { id: "income", label: "Income" },
        { id: "rent", label: "Rent" },
      ],
      links: [{ source: "income", target: "rent", value: 2100 }],
    });

    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.root).toBe("sankey");
    expect(payload.nodes).toEqual([
      {
        id: "sankey",
        component: "Sankey",
        source: "prewired",
        props: {
          title: "Where money went",
          nodes: [
            { id: "income", label: "Income" },
            { id: "rent", label: "Rent" },
          ],
          links: [{ source: "income", target: "rent", value: 2100 }],
        },
      },
    ]);
  });

  it("returns a repairable tool error and no view for invalid show_money_flow input", async () => {
    const internals = trackedInternals();
    const tool = internals.tools.find((t) => t.name === "show_money_flow");
    const input = {
      nodes: [{ id: "income", label: "Income" }],
      links: [{ source: "income", target: "missing", value: -1 }],
    };

    await expect(tool?.execute(input)).resolves.toMatchObject({
      shown: false,
      error: expect.any(String),
      repair: expect.stringContaining("show_money_flow"),
    });
    expect(tool?.toView?.(input, { shown: false })).toBeUndefined();
  });

  it("only includes integration tools when the integrations capability is enabled", async () => {
    expect(trackedInternals({ integrations: false }).tools.map((t) => t.name)).not.toContain(
      "list_integrations",
    );

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ enabled: true, integrations: [{ id: "gmail", connected: false }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const internals = trackedInternals({ basePath: "/custom/vendo", integrations: true });

    const list = internals.tools.find((t) => t.name === "list_integrations");
    expect(list).toBeDefined();
    await expect(list?.execute({})).resolves.toEqual({
      enabled: true,
      integrations: [{ id: "gmail", connected: false }],
    });
    expect(fetchMock).toHaveBeenCalledWith("/custom/vendo/integrations", { cache: "no-store" });

    const connect = internals.tools.find((t) => t.name === "request_connect");
    const view = connect?.toView?.({ toolkit: "gmail", reason: "Read invoices" }, {});
    expect(view).toMatchObject({
      kind: "component",
      source: "host",
      name: "Connect",
      props: { toolkit: "gmail", reason: "Read invoices" },
    });
  });

  it("fetches connected integration voice tools, registers read replay, and records session results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/voice/tools") && init?.method !== "POST") {
        return new Response(
          JSON.stringify({
            tools: [
              {
                name: "GMAIL_FETCH_EMAILS",
                description: "Fetch emails",
                parameters: { type: "object", properties: { query: { type: "string" } } },
                tier: "read",
              },
            ],
          }),
        );
      }
      if (url.endsWith("/voice/tools") && init?.method === "POST") {
        return new Response(JSON.stringify({ result: { data: { rows: [{ subject: "Invoice" }] } } }));
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const internals = trackedInternals({ basePath: "/custom/vendo", integrations: true });

    const session = await internals.createIntegrationVoiceTools();
    disposers.push(session.unregister);
    const gmail = session.tools.find((t) => t.name === "GMAIL_FETCH_EMAILS");
    expect(gmail?.tier).toBe("read");
    expect(replayRegistry.has("GMAIL_FETCH_EMAILS")).toBe(true);

    const output = await gmail?.execute({ query: "invoice" });
    expect(output).toEqual({ data: { rows: [{ subject: "Invoice" }] } });
    const view = internals.tableView({
      columns: [{ key: "subject", label: "Subject" }],
      rows: [{ subject: "Invoice" }],
      source: { tool: "GMAIL_FETCH_EMAILS", input: { query: "invoice" }, rowsPath: "/data/rows" },
    }) as { payload: GeneratedPayload };
    expect(view.payload.queries).toEqual([
      { path: "/source", tool: "GMAIL_FETCH_EMAILS", input: { query: "invoice" } },
    ]);

    session.unregister();
    expect(replayRegistry.has("GMAIL_FETCH_EMAILS")).toBe(false);
  });

  it("keeps the latest read-tool replay registration when an older driver is disposed", async () => {
    const first = trackedInternals({ hostTools: [readAccounts] });
    const second = trackedInternals({ hostTools: [readAccounts] });

    expect(replayRegistry.has("list_accounts")).toBe(true);
    first.dispose();
    expect(replayRegistry.has("list_accounts")).toBe(true);

    second.dispose();
    expect(replayRegistry.has("list_accounts")).toBe(false);
  });

  it("composes voice instructions from product persona, host tools, and fixed extras", () => {
    const internals = trackedInternals({
      productName: "Ledger",
      hostTools: [readAccounts],
      instructionsExtra: ["Always call dollars USD."],
    });

    expect(internals.instructions).toContain("You are Ledger's voice assistant");
    expect(internals.instructions).toContain("Read the app's own data: list_accounts.");
    expect(internals.instructions).toContain("Use English (US) by default");
    expect(internals.instructions).toContain("Never claim something is on screen");
    expect(internals.instructions).toContain("Always call dollars USD.");
    expect(internals.instructions).not.toContain("show_table");
  });
});
