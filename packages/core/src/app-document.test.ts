import { describe, expect, it } from "vitest";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  appDocumentSchema,
  validateAppDocument,
} from "./index.js";

const minimal = () => ({
  format: VENDO_APP_FORMAT,
  id: "app_chat",
  name: "Support Chat",
  ui: "tree" as const,
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
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
    formatVersion: VENDO_TREE_FORMAT,
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
    queries: [{ path: "/overdue", tool: "fn:list_overdue", input: { days: 30 } }],
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
      tree: { ...minimal().tree, queries: [{ path: "", tool: "fn:load" }] },
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
