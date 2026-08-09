import { describe, expect, it } from "vitest";
import { deriveProductSlug, prefixedToolName, VendoError } from "../src/index.js";

describe("the host's product slug (design §4)", () => {
  it("derives a slug from the product name", () => {
    expect(deriveProductSlug("Maple")).toBe("maple");
    expect(deriveProductSlug("Maple Bank")).toBe("maple_bank");
  });

  it("strips punctuation a tool name cannot carry", () => {
    expect(deriveProductSlug("Acme, Inc.")).toBe("acme_inc");
    expect(deriveProductSlug("Cadence—Books")).toBe("cadence_books");
    expect(deriveProductSlug("  spaced  out  ")).toBe("spaced_out");
  });

  it("collapses camelCase into readable words", () => {
    expect(deriveProductSlug("MapleBank")).toBe("maple_bank");
  });

  it("REFUSES the word host — the model must read these as native product actions", () => {
    // The whole point of the slug is that a tool reads like the product's own
    // verb. "host_" is our word, not the product's, and it leaks our plumbing.
    expect(() => deriveProductSlug("host")).toThrow(VendoError);
    expect(() => deriveProductSlug("Host")).toThrow(VendoError);
  });

  it("refuses a slug that would collide with our own reserved namespace", () => {
    expect(() => deriveProductSlug("vendo")).toThrow(VendoError);
    expect(() => deriveProductSlug("Vendo Apps")).toThrow(VendoError);
  });

  it("refuses a name with nothing usable in it, rather than inventing one", () => {
    expect(() => deriveProductSlug("!!!")).toThrow(VendoError);
    expect(() => deriveProductSlug("")).toThrow(VendoError);
  });

  it("refuses a slug starting with a digit — not a valid tool-name stem", () => {
    expect(() => deriveProductSlug("1Password")).toThrow(VendoError);
  });

  it("builds the tool name the model actually sees", () => {
    expect(prefixedToolName("maple", "invoices_list")).toBe("maple_invoices_list");
  });

  it("VALIDATES its slug, so the reserved ban cannot be bypassed (finding 18)", () => {
    // deriveProductSlug refuses these, but a caller can pass a slug straight to
    // prefixedToolName — which made the host/vendo ban trivially avoidable
    // through the configurable path the design explicitly offers.
    expect(() => prefixedToolName("host", "invoices_list")).toThrow(VendoError);
    expect(() => prefixedToolName("vendo", "invoices_list")).toThrow(VendoError);
    expect(() => prefixedToolName("vendo_apps", "invoices_list")).toThrow(VendoError);
  });

  it("refuses a malformed slug rather than minting an invalid tool name", () => {
    expect(() => prefixedToolName("", "invoices_list")).toThrow(VendoError);
    expect(() => prefixedToolName("1password", "invoices_list")).toThrow(VendoError);
    expect(() => prefixedToolName("Acme Inc", "invoices_list")).toThrow(VendoError);
  });

  it("does not double-prefix a stem that already carries the slug", () => {
    // Extraction runs more than once; a re-sync must not produce
    // maple_maple_invoices_list.
    expect(prefixedToolName("maple", "maple_invoices_list")).toBe("maple_invoices_list");
  });

  it("replaces a legacy host_ stem instead of stacking on top of it", () => {
    // The migration path: yesterday's extracted names begin with host_.
    expect(prefixedToolName("maple", "host_invoices_list")).toBe("maple_invoices_list");
  });

  it("keeps the result inside the tool-name pattern", () => {
    expect(prefixedToolName("maple_bank", "invoices_list")).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});
