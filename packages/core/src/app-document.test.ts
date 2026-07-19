import { describe, expect, it } from "vitest";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT_V2,
  WIRE_ISSUE_CODES,
  appDocumentSchema,
  compileWireV2,
  validateAppDocument,
} from "./index.js";

const minimal = () => ({
  format: VENDO_APP_FORMAT,
  id: "app_chat",
  name: "Support Chat",
  ui: "tree" as const,
  tree: {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { value: "How can I help?" } }],
  },
});

const invoiceChaser = () => ({
  format: VENDO_APP_FORMAT,
  id: "app_invoice_chaser",
  name: "Invoice Chaser",
  description: "Follows up on overdue invoices every Monday.",
  ui: "tree" as const,
  tree: {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["summary", "send"] },
      { id: "summary", component: "InvoiceSummary", source: "generated" as const },
      {
        id: "send",
        component: "Button",
        source: "host" as const,
        props: { onClick: { action: "fn:send_reminders", payload: { dryRun: true } } },
      },
    ],
    data: { overdue: [] },
    queries: [{ name: "overdue", tool: "fn:list_overdue", input: { days: 30 } }],
  },
  components: { InvoiceSummary: "export default function InvoiceSummary(){ return null; }" },
  storage: {
    invoices: {
      about: "Invoices being chased",
      kind: "records" as const,
      refs: { invoiceId: "host.invoice.id", customer: "host.customer_id" },
    },
    attachments: { about: "Supporting documents", kind: "files" as const },
  },
  server: "e2b:snap_x91",
  trigger: {
    on: { kind: "schedule" as const, cron: "0 9 * * 1" },
    run: {
      kind: "steps" as const,
      steps: [
        { id: "load", tool: "host_invoices_list", args: { overdue: "event.overdue" } },
        { id: "send", tool: "fn:send_reminders", if: "$count(steps.load) > 0" },
      ],
    },
  },
  egress: ["api.stripe.com", "api.resend.com"],
  secrets: ["RESEND_API_KEY"],
  pins: [{ slot: "invoice-card", base: "sha256:abc123" }],
  forkedFrom: "app_invoice_template",
  futureCapability: { version: 2, retained: true },
});

const expectValidation = (input: unknown): void => {
  const result = validateAppDocument(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("validation");
};

describe("appDocumentSchema and validateAppDocument", () => {
  it("round-trips a minimal chat view", () => {
    expect(appDocumentSchema.parse(minimal())).toEqual(minimal());
    expect(validateAppDocument(minimal())).toEqual({ ok: true, app: minimal() });
  });

  it("round-trips a full Invoice Chaser document losslessly", () => {
    const document = invoiceChaser();
    expect(appDocumentSchema.parse(document)).toEqual(document);
    expect(validateAppDocument(document)).toEqual({ ok: true, app: document });
  });

  it("accepts unknown UI formats as opaque payloads", () => {
    const document = {
      ...minimal(),
      tree: { formatVersion: "vendo-canvas/v2", opaque: { components: true, action: "fn:not_walked" } },
    };
    expect(validateAppDocument(document)).toEqual({ ok: true, app: document });
  });

  it("classifies wrong or absent app format as version", () => {
    for (const document of [
      { ...minimal(), format: "vendo/app@2" },
      (({ format: _format, ...rest }) => rest)(minimal()),
    ]) {
      const result = validateAppDocument(document);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("version");
    }
  });

  it("rejects the reserved state storage collection", () => {
    expectValidation({ ...minimal(), storage: { state: { about: "Reserved" } } });
  });

  it("requires a server for fn: query, prop action, and step references", () => {
    const query = {
      ...minimal(),
      tree: { ...minimal().tree, queries: [{ name: "load", tool: "fn:load" }] },
    };
    const action = {
      ...minimal(),
      tree: {
        ...minimal().tree,
        nodes: [{ id: "root", component: "Button", props: { nested: [{ action: "fn:click" }] } }],
      },
    };
    const step = {
      ...minimal(),
      trigger: {
        on: { kind: "host-event", event: "invoice.created" },
        run: { kind: "steps", steps: [{ id: "one", tool: "fn:process" }] },
      },
    };
    for (const document of [query, action, step]) expectValidation(document);
  });

  it("rejects malformed fn: references even when a server exists", () => {
    expectValidation({
      ...minimal(),
      server: "e2b:snap_ok",
      tree: {
        ...minimal().tree,
        nodes: [{ id: "root", component: "Button", props: { onClick: { action: "fn:bad name" } } }],
      },
    });
  });

  it("rejects components nested inside an at-rest v1 tree", () => {
    expectValidation({ ...minimal(), tree: { ...minimal().tree, components: {} } });
  });

  it("rejects bad pin bases, server refs, and host refs", () => {
    expectValidation({ ...minimal(), pins: [{ slot: "card", base: "md5:abc" }] });
    expectValidation({ ...minimal(), server: "SnapshotWithoutProvider" });
    expectValidation({
      ...minimal(),
      storage: { invoices: { about: "Invoices", refs: { invoice: "stripe.invoice" } } },
    });
  });

  it("rejects empty names, storage descriptions, and pin slots", () => {
    expectValidation({ ...minimal(), name: "" });
    expectValidation({ ...minimal(), storage: { invoices: { about: "" } } });
    expectValidation({ ...minimal(), pins: [{ slot: "", base: "sha256:abc" }] });
  });

  it("enforces component limits even without a v1 tree", () => {
    const base = { format: VENDO_APP_FORMAT, id: "app_x", name: "X" };
    expectValidation({ ...base, components: { Text: "export default () => null;" } }); // reserved
    expectValidation({ ...base, components: { "not-pascal": "x" } });
    expectValidation({ ...base, components: { Big: "x".repeat(65_537) } });
    expect(validateAppDocument({ ...base, components: { Gauge: "export default () => null;" } }).ok).toBe(true);
    // opaque-format tree beside components: caps still apply
    expectValidation({
      ...base,
      tree: { formatVersion: "vendo-canvas/v2" },
      components: { Text: "x" },
    });
  });

  it("rejects step tools that are neither valid tool names nor fn: references", () => {
    const withStep = (tool: string) => ({
      ...minimal(),
      server: "e2b:snap_ok",
      trigger: {
        on: { kind: "host-event", event: "e" },
        run: { kind: "steps", steps: [{ id: "s", tool }] },
      },
    });
    expectValidation(withStep("not a tool!!"));
    expectValidation(withStep("dotted.name"));
    expect(validateAppDocument(withStep("host_invoices_list")).ok).toBe(true);
    expect(validateAppDocument(withStep("fn:process")).ok).toBe(true);
  });

  it("never throws on hostile inputs with throwing getters", () => {
    const hostile = Object.defineProperty({}, "format", {
      enumerable: true,
      get() {
        throw Object.defineProperty(new Error("boom"), "message", {
          get() {
            throw new Error("nested boom");
          },
        });
      },
    });
    const result = validateAppDocument(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

const v2Minimal = () => ({
  format: VENDO_APP_FORMAT,
  id: "app_v2",
  name: "V2 App",
  ui: "tree" as const,
  tree: {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "How can I help?" } }],
  },
});

const expectValidationMessage = (input: unknown, message: string): void => {
  const result = validateAppDocument(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("validation");
    expect(result.error.message).toBe(message);
  }
};

describe("validateAppDocument with vendo-genui/v2 trees", () => {
  it("accepts a v2 tree whose generated nodes are backed by document-level components", () => {
    const document = {
      ...v2Minimal(),
      tree: {
        formatVersion: VENDO_TREE_FORMAT_V2,
        root: "root",
        nodes: [
          { id: "root", component: "Stack", children: ["gauge"] },
          { id: "gauge", component: "Gauge", source: "generated" as const },
        ],
      },
      components: { Gauge: "export default function Gauge(){ return null; }" },
    };
    expect(appDocumentSchema.parse(document)).toEqual(document);
    expect(validateAppDocument(document)).toEqual({ ok: true, app: document });
  });

  it("rejects components smuggled inside a v2 tree with the tree validator's message", () => {
    expectValidationMessage(
      { ...v2Minimal(), tree: { ...v2Minimal().tree, components: {} } },
      "v2 trees must not carry components (they live at the app-document level)",
    );
  });

  it("rejects generated nodes with no definition in the document components", () => {
    expectValidationMessage(
      {
        ...v2Minimal(),
        tree: {
          ...v2Minimal().tree,
          nodes: [{ id: "root", component: "Gauge", source: "generated" as const }],
        },
      },
      'node "root" references generated component "Gauge" with no definition in components',
    );
  });

  it("enforces document component limits beside a v2 tree", () => {
    expectValidation({ ...v2Minimal(), components: { Text: "export default () => null;" } }); // reserved
    expectValidation({ ...v2Minimal(), components: { "not-pascal": "x" } });
  });

  it("requires a server for fn: v2 query tools and prop actions", () => {
    const withQuery = {
      ...v2Minimal(),
      tree: { ...v2Minimal().tree, queries: [{ name: "load", tool: "fn:load" }] },
    };
    expectValidationMessage(withQuery, "fn: references require an app server");
    expect(validateAppDocument({ ...withQuery, server: "e2b:snap_ok" }).ok).toBe(true);
    expectValidationMessage(
      {
        ...v2Minimal(),
        tree: {
          ...v2Minimal().tree,
          nodes: [{ id: "root", component: "Button", props: { nested: [{ action: "fn:click" }] } }],
        },
      },
      "fn: references require an app server",
    );
  });

  it("rejects malformed fn: prop actions in v2 nodes even when a server exists", () => {
    expectValidation({
      ...v2Minimal(),
      server: "e2b:snap_ok",
      tree: {
        ...v2Minimal().tree,
        nodes: [{ id: "root", component: "Button", props: { onClick: { action: "fn:bad name" } } }],
      },
    });
  });

  it("rejects malformed fn: v2 query tools even when a server exists", () => {
    expectValidation({
      ...v2Minimal(),
      server: "e2b:snap_ok",
      tree: { ...v2Minimal().tree, queries: [{ name: "load", tool: "fn:bad name" }] },
    });
  });

  it("leaves v1 documents and opaque unknown formats untouched", () => {
    expect(validateAppDocument(minimal())).toEqual({ ok: true, app: minimal() });
    expect(validateAppDocument(invoiceChaser())).toEqual({ ok: true, app: invoiceChaser() });
    const opaque = {
      ...minimal(),
      tree: { formatVersion: "vendo-canvas/v3", opaque: { components: true, action: "fn:not_walked" } },
    };
    expect(validateAppDocument(opaque)).toEqual({ ok: true, app: opaque });
  });

  it("exports the wire compiler and issue registry from the package root", () => {
    expect(WIRE_ISSUE_CODES).toContain("missing-app");
    const compiled = compileWireV2('<App name="Tiny"><Text>hi</Text></App>');
    expect(compiled.complete).toBe(true);
    expect(compiled.issues).toEqual([]);
    expect(compiled.name).toBe("Tiny");
    const document = {
      format: VENDO_APP_FORMAT,
      id: "app_wire",
      name: compiled.name ?? "Tiny",
      ui: "tree" as const,
      tree: compiled.tree,
      components: compiled.components,
    };
    expect(validateAppDocument(document)).toEqual({ ok: true, app: document });
  });
});
