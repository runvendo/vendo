import { describe, expect, it } from "vitest";
import { renderLooseningDiff, reviewLoosenings, sanitize, type LooseningReviewItem } from "../../../src/cli/judge/review.js";

const ESC = "\u001b";
const BEL = "\u0007";
const CSI = "\u009b";

const item = (overrides: Partial<LooseningReviewItem> = {}): LooseningReviewItem => ({
  name: "host_list_invoices",
  field: "risk",
  from: "destructive",
  to: "read",
  evidence: "const rows = await db.select().from(invoices)",
  ...overrides,
});

describe("renderLooseningDiff", () => {
  it("renders field: old -> new, the indented evidence quote, and the reason", () => {
    const lines = renderLooseningDiff([item({ reason: "the handler only reads" })]);
    const text = lines.join("\n");
    expect(text).toContain("host_list_invoices");
    expect(text).toContain("risk: destructive → read");
    expect(text).toContain("const rows = await db.select().from(invoices)");
    expect(text).toContain("the handler only reads");
  });

  it("groups several loosenings under ONE heading per tool", () => {
    const lines = renderLooseningDiff([
      item({ field: "risk", from: "destructive", to: "read" }),
      item({ field: "disabled", from: true, to: false, evidence: "requireUser(session)" }),
    ]);
    expect(lines.filter((line) => line.trim() === "host_list_invoices")).toHaveLength(1);
    expect(lines.join("\n")).toContain("disabled: true → false");
  });

  it("SANITIZES control characters out of the evidence quote and the reason", () => {
    // A hostile handler comment steering the model into an ANSI escape: the
    // operator reads THIS diff to decide a capability loosening, so a spoofable
    // line is the whole attack.
    const lines = renderLooseningDiff([item({
      evidence: `safe${ESC}[2Kspoofed${BEL}`,
      reason: `also${ESC}[31mred${CSI}`,
    })]);
    const text = lines.join("\n");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(BEL);
    expect(text).not.toContain(CSI);
    // The visible characters survive — only the control bytes are stripped.
    expect(text).toContain("safe[2Kspoofed");
    expect(text).toContain("also[31mred");
  });
});

describe("reviewLoosenings", () => {
  it("prints the diff through `note` and returns approved on yes", async () => {
    const notes: string[] = [];
    const asked: string[] = [];
    const verdict = await reviewLoosenings([item()], {
      note: (line) => notes.push(line),
      confirm: async (question) => { asked.push(question); return true; },
    });
    expect(verdict).toBe("approved");
    expect(notes.join("\n")).toContain("risk: destructive → read");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("1 loosening");
  });

  it("returns declined on no", async () => {
    const verdict = await reviewLoosenings([item()], {
      note: () => {},
      confirm: async () => false,
    });
    expect(verdict).toBe("declined");
  });

  it("an empty set is approved without asking anything", async () => {
    const verdict = await reviewLoosenings([], {
      note: () => {},
      confirm: async () => { throw new Error("nothing to review must never prompt"); },
    });
    expect(verdict).toBe("approved");
  });
});

describe("sanitize", () => {
  it("strips C0, DEL and C1 but keeps tab and ordinary text", () => {
    expect(sanitize(`a\tb\u0000c${ESC}d${CSI}e\u007f`)).toBe("a\tbcde");
  });
});

describe("reviewLoosenings — subject/verb agreement in the notice", () => {
  it("says `1 loosening needs` for one and `2 loosenings need` for many", async () => {
    const one: string[] = [];
    await reviewLoosenings([item()], { note: (line) => one.push(line), confirm: async () => false });
    expect(one[0]).toContain("1 loosening needs a human decision");

    const many: string[] = [];
    await reviewLoosenings(
      [item(), item({ field: "disabled", from: true, to: false })],
      { note: (line) => many.push(line), confirm: async () => false },
    );
    expect(many[0]).toContain("2 loosenings need a human decision");
  });
});

describe("renderLooseningDiff — every model-authored part is sanitized", () => {
  it("SANITIZES the proposed value, not only the evidence and reason", () => {
    // PendingLoosening.value is an arbitrary string on the wire, and it is
    // rendered as the "-> new" side of the very diff a human approves.
    const lines = renderLooseningDiff([item({ to: `read${ESC}[2K spoofed` })]);
    const text = lines.join("\n");
    expect(text).not.toContain(ESC);
    expect(text).toContain("read[2K spoofed");
  });

  it("SANITIZES the tool-name heading", () => {
    const lines = renderLooseningDiff([item({ name: `${ESC}]0;pwned${BEL}host_x` })]);
    const text = lines.join("\n");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(BEL);
    expect(text).toContain("host_x");
  });
});
