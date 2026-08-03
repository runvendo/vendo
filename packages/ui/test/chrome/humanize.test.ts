// @vitest-environment node
import { describe, expect, it } from "vitest";
import { VENDO_TOOL_TITLES } from "@vendoai/core";
import { argFields, humanizeToolName, summarizeArgs, toolTitle } from "../../src/chrome/humanize.js";

describe("humanizeToolName — prettified-id fallback", () => {
  it("strips the host_ prefix and sentence-cases the remainder", () => {
    expect(humanizeToolName("host_email_send")).toBe("Email send");
    expect(humanizeToolName("host_listClientDocuments")).toBe("List client documents");
  });

  it("strips the fn: prefix", () => {
    expect(humanizeToolName("fn:listInvoices")).toBe("List invoices");
  });

  it("splits camelCase and collapses SCREAMING_SNAKE toolkit slugs", () => {
    // A real Composio-style id: readable, no literal underscores, deduped toolkit token.
    expect(humanizeToolName("gmail_GMAIL_CREATE_EMAIL_DRAFT")).toBe("Gmail create email draft");
  });

  it("never returns an empty string", () => {
    expect(humanizeToolName("___")).toBe("___");
    expect(humanizeToolName("")).toBe("");
  });
});

describe("toolTitle — host metadata wins over the fallback", () => {
  it("uses the host-supplied label when present", () => {
    expect(toolTitle("host_email_send", { label: "Send email" })).toBe("Send email");
  });

  it("falls back to the prettified id when no label", () => {
    expect(toolTitle("host_email_send", {})).toBe("Email send");
    expect(toolTitle("host_email_send", undefined)).toBe("Email send");
  });

  it("ignores a blank label", () => {
    expect(toolTitle("host_email_send", { label: "  " })).toBe("Email send");
  });
});

describe("argFields / summarizeArgs — readable arg formatting", () => {
  it("turns an object into humanized Key: value rows", () => {
    expect(argFields({ invoiceId: "inv_42", permanent: true })).toEqual([
      { label: "Invoice id", value: "inv_42" },
      { label: "Permanent", value: "true" },
    ]);
  });

  it("returns no rows for non-object args", () => {
    expect(argFields("hello")).toEqual([]);
    expect(argFields(null)).toEqual([]);
    expect(argFields([1, 2])).toEqual([]);
  });

  it("summarizes the first few scalars into one line, no raw JSON braces", () => {
    const summary = summarizeArgs({ to: "finance@example.com", subject: "Invoice ready" });
    expect(summary).toBe("To finance@example.com · Subject Invoice ready");
    expect(summary).not.toContain("{");
    expect(summary).not.toContain("\"");
  });

  it("returns undefined when there is nothing to summarize", () => {
    expect(summarizeArgs({})).toBeUndefined();
    expect(summarizeArgs("plain string")).toBeUndefined();
  });
});

describe("toolTitle — Vendo's own tools have titles, not slugs (§3 consumer voice)", () => {
  // Wave-1 live proof E1-5: the progress chip read "Vendo apps edit…". The
  // rendering layer never sees a descriptor for a non-approval surface, so the
  // slug prettifier was the whole label — and it prettifies Vendo's OWN
  // namespace into words the user reads as jargon.
  it("titles Vendo's own tools from the shared table", () => {
    expect(toolTitle("vendo_apps_edit")).toBe(VENDO_TOOL_TITLES.vendo_apps_edit);
    expect(toolTitle("vendo_apps_edit")).not.toMatch(/vendo/i);
    expect(toolTitle("vendo_apps_create")).not.toMatch(/vendo/i);
    expect(toolTitle("vendo_knowledge_search")).not.toMatch(/vendo/i);
  });

  it("keeps the authority order: host label, then the descriptor, then the table", () => {
    expect(toolTitle("vendo_apps_edit", { label: "Tweak my dashboard" })).toBe("Tweak my dashboard");
    expect(toolTitle("vendo_apps_edit", undefined, "Change the app")).toBe("Change the app");
  });

  it("leaves host tools to the existing fallback", () => {
    expect(toolTitle("host_email_send")).toBe("Email send");
  });
});
