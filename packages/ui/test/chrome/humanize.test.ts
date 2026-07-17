// @vitest-environment node
import { describe, expect, it } from "vitest";
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
