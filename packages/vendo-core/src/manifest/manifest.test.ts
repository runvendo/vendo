import { describe, expect, it } from "vitest";
import { manifestComponentSchema } from "./component";
import { vendoManifestSchema, toolsManifestSchema } from "./manifest";

const theme = {
  version: 1,
  accent: "#0A7CFF",
  background: "#FFFFFF",
  surface: "#F5F7FA",
  text: "#111418",
  mutedText: "#5B6470",
  fontFamily: "system-ui, sans-serif",
  radius: 8,
};
const tool = {
  name: "listInvoices",
  description: "List invoices.",
  inputSchema: { type: "object" },
  annotations: { mutating: false, dangerous: false },
  binding: { type: "http", method: "GET", path: "/api/invoices" },
};
const component = {
  name: "InvoiceCard",
  description: "The host's invoice summary card.",
  propsSchema: { type: "object", properties: { invoiceId: { type: "string" } } },
};

describe("manifestComponentSchema", () => {
  it("accepts a serialized descriptor", () => {
    expect(() => manifestComponentSchema.parse(component)).not.toThrow();
  });
});

describe("toolsManifestSchema (tools.json file)", () => {
  it("accepts tools + events, defaulting events to []", () => {
    const parsed = toolsManifestSchema.parse({ version: 1, tools: [tool] });
    expect(parsed.events).toEqual([]);
  });
});

describe("vendoManifestSchema (published unit)", () => {
  it("accepts a complete manifest", () => {
    expect(() =>
      vendoManifestSchema.parse({
        schemaVersion: 1,
        theme,
        tools: [tool],
        events: [],
        components: [component],
      }),
    ).not.toThrow();
  });

  it("rejects a manifest missing the theme", () => {
    expect(() =>
      vendoManifestSchema.parse({ schemaVersion: 1, tools: [], events: [], components: [] }),
    ).toThrow();
  });

  it("rejects unknown keys (parity with additionalProperties: false)", () => {
    expect(() => manifestComponentSchema.parse({ ...component, wrapperPath: "./x" })).toThrow();
    expect(() => toolsManifestSchema.parse({ version: 1, tools: [], extra: 1 })).toThrow();
    expect(() =>
      vendoManifestSchema.parse({
        schemaVersion: 1,
        theme,
        tools: [],
        events: [],
        components: [],
        extra: 1,
      }),
    ).toThrow();
  });
});
