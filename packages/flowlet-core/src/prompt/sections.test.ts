import { describe, expect, it } from "vitest";
import {
  capabilitiesSection,
  connectSection,
  consentSection,
  genuiFormatSection,
  guardrailSection,
  proactivitySection,
  refreshableViewsSection,
  registerSection,
  showVsSaySection,
  styleSection,
} from "./sections";

const HOSTY = /maple|cadence|bank|acme/i;

describe("prompt sections", () => {
  it("every section renders for both modalities without host-flavored strings", () => {
    const all = [
      genuiFormatSection(),
      showVsSaySection("chat"),
      showVsSaySection("voice"),
      refreshableViewsSection("chat"),
      refreshableViewsSection("voice"),
      connectSection("chat", { toolkits: ["gmail", "slack"] }),
      connectSection("voice"),
      consentSection("chat"),
      consentSection("voice"),
      styleSection({ noEmoji: true }),
      registerSection("chat"),
      registerSection("voice"),
      capabilitiesSection("chat"),
      capabilitiesSection("voice"),
      proactivitySection("chat"),
      proactivitySection("voice"),
      guardrailSection("chat"),
      guardrailSection("voice"),
    ];
    for (const section of all) {
      expect(section.length).toBeGreaterThan(20);
      expect(section).not.toMatch(HOSTY);
    }
  });

  it("chat show-vs-say keeps the shipped render-vs-talk rules verbatim anchors", () => {
    const s = showVsSaySection("chat");
    expect(s).toContain("WHEN TO RENDER UI vs. JUST TALK");
    expect(s).toContain("Most turns are text.");
    expect(s).toContain("When unsure, default to text.");
  });

  it("voice show-vs-say covers the approved failure modes", () => {
    const s = showVsSaySection("voice");
    expect(s).toContain("Never read more than three items aloud");
    expect(s).toMatch(/Connect and approval cards/);
    expect(s).toMatch(/already visible/);
    expect(s).toMatch(/pulling up March/);
  });

  it("voice register carries the anti-yap rules", () => {
    const s = registerSection("voice");
    expect(s).toMatch(/at most two sentences/);
    expect(s).toMatch(/Never announce/);
    expect(s).not.toMatch(/anything else\?" is fine/);
  });

  it("voice refreshable views teach the source declaration", () => {
    const s = refreshableViewsSection("voice");
    expect(s).toContain("source: { tool, input, rowsPath }");
    expect(s).toMatch(/raw field names/);
  });

  it("chat genui + refreshable sections keep the shipped protocol text anchors", () => {
    expect(genuiFormatSection()).toContain("formatVersion: 'flowlet-genui/v1'");
    expect(refreshableViewsSection("chat")).toContain("queries: [{ path:");
  });

  it("connect(chat) lists the provided toolkits; connect(voice) is the tools-present rule", () => {
    expect(connectSection("chat", { toolkits: ["gmail", "notion"] })).toContain("gmail, notion");
    expect(connectSection("voice")).toMatch(/IS connected/);
  });

  it("consent(voice) is the yes-recency rule (driver protocol lives in consent-strings)", () => {
    const s = consentSection("voice");
    expect(s).toMatch(/MOST RECENT permission request/);
  });

  it("guardrail says platform rules win", () => {
    expect(guardrailSection("chat")).toMatch(/these rules win/i);
  });
});

describe("integrations completeness (live check feedback)", () => {
  it("chat: capability talk demands the complete connectable list, no abbreviation", () => {
    const s = capabilitiesSection("chat");
    expect(s).toMatch(/COMPLETE connectable list/);
    expect(s).toMatch(/never an abbreviated/);
  });

  it("voice: the complete list goes on screen, not recited aloud", () => {
    const s = capabilitiesSection("voice");
    expect(s).toMatch(/complete\s+connectable list on screen/);
  });
});
