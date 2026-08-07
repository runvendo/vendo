import { VendoError, type ToolDescriptor, type ToolOutcome, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { withUniqueToolTitles } from "./duplicate-titles.js";

/** Finding 6 — the gate threw on enumeration but let EXECUTE straight through, so
 *  a colliding deployment still performed a real mutating call. */
const tool = (name: string, title?: string): ToolDescriptor => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" },
  risk: "destructive",
  ...(title === undefined ? {} : { title }),
});

const ctx = {
  principal: { kind: "user" as const, subject: "user_1" },
  venue: "chat" as const,
  presence: "present" as const,
  sessionId: "s1",
};

function stack(descriptors: ToolDescriptor[]): { registry: ToolRegistry; executed: string[] } {
  const executed: string[] = [];
  const registry: ToolRegistry = {
    descriptors: async () => descriptors,
    execute: async (call): Promise<ToolOutcome> => {
      executed.push(call.tool);
      return { status: "ok", output: {} };
    },
  };
  return { registry: withUniqueToolTitles(registry), executed };
}

describe("a colliding deployment cannot EXECUTE either (finding 6)", () => {
  it("refuses the call instead of performing a mutating host request", async () => {
    const { registry, executed } = stack([
      tool("maple_payments_send", "Send money"),
      tool("maple_transfers_create", "Send money"),
    ]);

    await expect(
      registry.execute({ id: "c1", tool: "maple_payments_send", args: { amount: 5000 } }, ctx),
    ).rejects.toBeInstanceOf(VendoError);

    // The load-bearing assertion: the tool never ran.
    expect(executed).toEqual([]);
  });

  it("still executes normally when titles are distinct", async () => {
    const { registry, executed } = stack([tool("a", "Alpha"), tool("b", "Beta")]);
    await expect(registry.execute({ id: "c1", tool: "a", args: {} }, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(executed).toEqual(["a"]);
  });
});

describe("titles collide the way a PERSON reads them, not the way bytes compare", () => {
  const collides = async (left: string, right: string): Promise<boolean> => {
    const { registry } = stack([tool("a", left), tool("b", right)]);
    try {
      await registry.descriptors();
      return false;
    } catch {
      return true;
    }
  };

  it("case and surrounding whitespace do not distinguish two actions", async () => {
    expect(await collides("Send money", "  send MONEY ")).toBe(true);
  });

  it("collapses internal whitespace runs", async () => {
    expect(await collides("Send  money", "Send money")).toBe(true);
  });

  it("treats a zero-width space as invisible, because it is", async () => {
    // The real spoofing shape: a ZWSP smuggled into an otherwise identical
    // title, so the two render the same on a card but differ as bytes.
    expect(await collides("Send money", "​Send money")).toBe(true);
    expect(await collides("Send money", "Send​ money")).toBe(true);
  });

  it("treats a non-breaking space as a space", async () => {
    expect(await collides("Send money", "Send money")).toBe(true);
  });

  it("ignores a right-to-left mark", async () => {
    expect(await collides("Send money", "Send money‏")).toBe(true);
  });

  it("normalises decomposed and composed accents to one title", async () => {
    // "Café" typed two ways renders identically on a card.
    expect(await collides("Café charge", "Café charge")).toBe(true);
  });

  it("normalises compatibility forms (NFKC)", async () => {
    expect(await collides("Send money", "Ｓend money")).toBe(true);
  });

  it("treats a whitespace-only title as no title rather than a collision key", async () => {
    // Two blank titles are a labelling bug, but they must not read as one
    // shared title — and a blank title is unusable on a card either way.
    const { registry } = stack([tool("a", "   "), tool("b", "​")]);
    await expect(registry.descriptors()).rejects.toBeInstanceOf(VendoError);
  });

  it("keeps genuinely different titles apart", async () => {
    expect(await collides("Send money", "Send invoice")).toBe(false);
  });
});
