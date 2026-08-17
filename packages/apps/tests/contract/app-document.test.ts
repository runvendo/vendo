import { describe, expect, it } from "vitest";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import {
  appDocumentSchema,
  validateAppDocument,
} from "../../src/contract/index.js";

const minimal = () => ({
  format: VENDO_APP_FORMAT,
  id: "app_chat",
  name: "Support Chat",
  ui: "tree" as const,
});

const invoiceChaser = () => ({
  format: VENDO_APP_FORMAT,
  id: "app_invoice_chaser",
  name: "Invoice Chaser",
  description: "Follows up on overdue invoices every Monday.",
  ui: "tree" as const,
  components: { InvoiceSummary: "export default function InvoiceSummary(){ return null; }" },
  storage: {
    invoices: {
      about: "Invoices being chased",
      kind: "records" as const,
      refs: { invoiceId: "host.invoice.id", customer: "host.customer_id" },
    },
    attachments: { about: "Supporting documents", kind: "files" as const },
  },
  machine: { snapshotRef: "e2b:v2:snap_x91", provisionedAt: "2026-07-19T12:00:00.000Z" },
  automations: ["atm_chase"],
  egress: ["api.stripe.com", "api.resend.com"],
  secrets: ["RESEND_API_KEY"],
  seed: { component: "invoice-card", baseline: "sha256:abc123", instruction: "chase the late ones" },
  forkedFrom: "app_invoice_template",
  futureCapability: { version: 2, retained: true },
});

/** Assert a refusal, and — where the message IS the contract — the exact words. */
const expectValidation = (input: unknown, message?: string): void => {
  const result = validateAppDocument(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("validation");
    if (message !== undefined) expect(result.error.message).toBe(message);
  }
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

  it("loads a pre-instruction seeded document, defaulting the instruction to empty", () => {
    // Apps seeded before the ✦ gesture collected an instruction verbatim stored
    // a seed without one. They must still load, or every app remixed before the
    // field existed fails the read-side integrity check and never opens again.
    const legacy = { ...minimal(), seed: { component: "invoice-card", baseline: "sha256:abc123" } };
    const expected = { ...legacy, seed: { ...legacy.seed, instruction: "" } };
    expect(appDocumentSchema.parse(legacy)).toEqual(expected);
    expect(validateAppDocument(legacy)).toEqual({ ok: true, app: expected });
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

  it("rejects bad pin bases and host refs", () => {
    expectValidation({ ...minimal(), seed: { component: "card", baseline: "md5:abc", instruction: "make it mine" } });
    expectValidation({
      ...minimal(),
      storage: { invoices: { about: "Invoices", refs: { invoice: "stripe.invoice" } } },
    });
  });

  it("rejects empty names, storage descriptions, and pin slots", () => {
    expectValidation({ ...minimal(), name: "" });
    expectValidation({ ...minimal(), storage: { invoices: { about: "" } } });
    expectValidation({ ...minimal(), seed: { component: "", baseline: "sha256:abc", instruction: "make it mine" } });
  });

  it("enforces the pinned component limits", () => {
    const base = { format: VENDO_APP_FORMAT, id: "app_x", name: "X" };
    expectValidation({ ...base, components: { Text: "export default () => null;" } }); // reserved
    expectValidation({ ...base, components: { "not-pascal": "x" } });
    expectValidation({ ...base, components: { Big: "x".repeat(65_537) } });
    expect(validateAppDocument({ ...base, components: { Gauge: "export default () => null;" } }).ok).toBe(true);
  });

  it("validates componentTools against the components map and tool-name grammar", () => {
    const base = {
      format: VENDO_APP_FORMAT,
      id: "app_x",
      name: "X",
      components: { Gauge: "export default () => null;" },
    };
    // W4b — a stamped per-island tool manifest rides beside components.
    expect(validateAppDocument({ ...base, componentTools: { Gauge: ["clients_search"] } }).ok).toBe(true);
    expect(validateAppDocument({ ...base, componentTools: { Gauge: [] } }).ok).toBe(true);
    // A manifest for an island that does not exist is a stamping bug.
    expectValidation({ ...base, componentTools: { Missing: ["clients_search"] } });
    // Manifest entries are registry tool names — the flat grammar, never dotted.
    expectValidation({ ...base, componentTools: { Gauge: ["clients.search"] } });
    expectValidation({ ...minimal(), componentTools: { Gauge: ["clients_search"] } });
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

describe("appDocumentSchema machine field (execution-v2)", () => {
  const withMachine = () => ({
    ...minimal(),
    machine: { snapshotRef: "e2b:snap_42", provisionedAt: "2026-07-19T12:00:00.000Z" },
  });

  it("round-trips a document with a machine reference", () => {
    const document = withMachine();
    expect(appDocumentSchema.parse(document)).toEqual(document);
    expect(validateAppDocument(document)).toEqual({ ok: true, app: document });
  });

  it("keeps the machine optional: an app without one is a layer-1 tree app", () => {
    const result = validateAppDocument(minimal());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.app.machine).toBeUndefined();
  });

  it("rejects a machine snapshotRef without a provider prefix", () => {
    expectValidation({
      ...minimal(),
      machine: { snapshotRef: "snap_42", provisionedAt: "2026-07-19T12:00:00.000Z" },
    });
  });

  it("rejects a machine with a malformed provisionedAt", () => {
    expectValidation({
      ...minimal(),
      machine: { snapshotRef: "e2b:snap_42", provisionedAt: "yesterday" },
    });
  });

  it("rejects a machine missing its snapshotRef", () => {
    expectValidation({
      ...minimal(),
      machine: { provisionedAt: "2026-07-19T12:00:00.000Z" },
    });
  });
});

// Contract §3.2 — a checkout writes each `source` key to disk, so the key space
// is a security surface: `../` or a leading slash would put one app's checkout in
// another app's files. The document validator is the gate every stored document
// passes, so the rule lives there rather than at the write.
describe("source", () => {
  const file = { hash: `sha256:${"a".repeat(64)}`, bytes: 3, text: "abc" };

  it("round-trips a relative path", () => {
    const withSource = { ...minimal(), source: { "src/App.tsx": file } };
    expect(appDocumentSchema.parse(withSource)).toEqual(withSource);
    expect(validateAppDocument(withSource)).toEqual({ ok: true, app: withSource });
  });

  it("refuses a path that escapes the app's directory", () => {
    for (const path of ["../other/App.tsx", "/etc/passwd", "src/../../x.ts", "src//App.tsx", "./App.tsx"]) {
      const result = validateAppDocument({ ...minimal(), source: { [path]: file } });
      expect(result.ok, path).toBe(false);
    }
  });

  it("refuses a file carrying both text and a blobRef, or neither", () => {
    expect(validateAppDocument({
      ...minimal(),
      source: { "a.ts": { ...file, blobRef: "wsb_1" } },
    }).ok).toBe(false);
    expect(validateAppDocument({
      ...minimal(),
      source: { "a.ts": { hash: file.hash, bytes: 3 } },
    }).ok).toBe(false);
  });
});
