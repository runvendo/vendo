import { afterEach, describe, expect, it, vi } from "vitest";
import { replayRegistry } from "@vendoai/shell";
import type { GeneratedPayload, HostToolDefinition } from "@vendoai/core";
import { __voiceTesting } from "./voice";

const { createVoiceInternals } = __voiceTesting;

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
  vi.unstubAllGlobals();
});

describe("createVendoVoice internals", () => {
  it("builds a data-bound table payload when source matches the replay cache", () => {
    const internals = createVoiceInternals();
    const raw = { ok: true, data: { rows: [{ merchant: "Cafe", amount: 42 }] } };
    replayRegistry.register("listTransactionsForPackagedVoice", async () => raw);
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
    const internals = createVoiceInternals();
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

  it("only includes integration tools when the integrations capability is enabled", async () => {
    expect(createVoiceInternals({ integrations: false }).tools.map((t) => t.name)).not.toContain(
      "list_integrations",
    );

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ enabled: true, integrations: [{ id: "gmail", connected: false }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const internals = createVoiceInternals({ basePath: "/custom/vendo", integrations: true });

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

  it("composes voice instructions from product persona, host tools, and fixed extras", () => {
    const internals = createVoiceInternals({
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
