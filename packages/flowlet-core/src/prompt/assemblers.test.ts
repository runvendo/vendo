import { describe, expect, it } from "vitest";
import { buildChatInstructions, buildVoiceInstructions } from "./assemblers";
import { capabilitySummary } from "./capability-summary";

describe("buildChatInstructions", () => {
  it("assembles in the guarded order: platform → host slots → extras → guardrails last", () => {
    const text = buildChatInstructions({
      identity: "You are Testo's assistant.",
      brandGuidance: "BRAND: be calm.",
      catalogs: "BUILDING BLOCKS: Stack, Row.",
      capabilities: "You can do host things.",
      toolkits: ["gmail", "slack"],
      extras: ["HOST EXTRA ALPHA", "HOST EXTRA BETA"],
    });
    const order = [
      "Testo's assistant",
      "WHEN TO RENDER UI",
      "BRAND: be calm.",
      "HOW render_view WORKS",
      "REFRESHABLE VIEWS",
      "BUILDING BLOCKS",
      "You can do host things.",
      "CONNECTING TOOLS",
      "HOST EXTRA ALPHA",
      "HOST EXTRA BETA",
      "NON-NEGOTIABLES",
    ];
    let last = -1;
    for (const anchor of order) {
      const at = text.indexOf(anchor);
      expect(at, `missing or out of order: ${anchor}`).toBeGreaterThan(last);
      last = at;
    }
    // Guardrails are the FINAL section — nothing after them.
    expect(text.indexOf("NON-NEGOTIABLES")).toBeGreaterThan(text.indexOf("HOST EXTRA BETA"));
    expect(text.trimEnd().endsWith("these rules win.")).toBe(true);
  });

  it("omits empty slots without leaving blank seams", () => {
    const text = buildChatInstructions({ identity: "You are X." });
    expect(text).not.toContain("\n\n\n");
    expect(text).toContain("NON-NEGOTIABLES");
  });

  it("threads the tool summary into the capabilities section", () => {
    const summary = capabilitySummary(
      [
        { name: "listThings", tier: "read", source: "host" },
        { name: "GMAIL_SEARCH", tier: "read", source: "integration", toolkit: "gmail" },
      ],
      ["gmail", "slack"],
    );
    const text = buildChatInstructions({ identity: "You are X.", toolSummary: summary });
    expect(text).toContain("listThings");
    expect(text).toContain("Connected integrations you can use now: gmail.");
    expect(text).toContain("NOT connected (offer to connect, never claim): slack.");
  });
});

describe("buildVoiceInstructions", () => {
  it("carries persona, anti-yap, show-vs-say, source protocol, and guardrails last", () => {
    const text = buildVoiceInstructions({
      persona: "You are Testo's voice assistant.",
      extras: ["Amounts are in integer cents."],
    });
    const order = [
      "Testo's voice assistant",
      "HOW YOU SPEAK",
      "SHOW vs SAY",
      "REFRESHABLE VIEWS",
      "MOST RECENT permission request",
      "Amounts are in integer cents.",
      "NON-NEGOTIABLES",
    ];
    let last = -1;
    for (const anchor of order) {
      const at = text.indexOf(anchor);
      expect(at, `missing or out of order: ${anchor}`).toBeGreaterThan(last);
      last = at;
    }
  });

  it("contains no host strings when host inputs are neutral", () => {
    const text = buildVoiceInstructions({ persona: "You are a voice assistant." });
    expect(text).not.toMatch(/maple|bank|cadence/i);
  });
});

describe("capabilitySummary", () => {
  it("returns empty for an empty toolset with nothing connectable", () => {
    expect(capabilitySummary([], [])).toBe("");
  });

  it("separates reads from gated actions", () => {
    const s = capabilitySummary(
      [
        { name: "listA", tier: "read", source: "host" },
        { name: "createB", tier: "act", source: "host" },
        { name: "deleteC", tier: "critical", source: "host" },
      ],
      [],
    );
    expect(s).toContain("Read the app's own data: listA.");
    expect(s).toContain("pauses for the user's approval): createB, deleteC.");
  });
});

describe("connect section conditionality", () => {
  it("omits CONNECTING TOOLS when the host has no integrations", () => {
    const text = buildChatInstructions({ identity: "You are X." });
    expect(text).not.toContain("CONNECTING TOOLS");
  });
});
