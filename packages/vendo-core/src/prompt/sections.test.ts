import { describe, expect, it } from "vitest";
import {
  capabilitiesSection,
  connectSection,
  consentSection,
  dataFidelitySection,
  genuiFormatSection,
  guardrailSection,
  hostIdentitySection,
  proactivitySection,
  registerSection,
  showVsSaySection,
  styleSection,
} from "./sections.js";

const HOSTY = /maple|cadence|bank|acme/i;

describe("prompt sections", () => {
  it("every section renders for both modalities without host-flavored strings", () => {
    const all = [
      genuiFormatSection(),
      showVsSaySection("chat"),
      showVsSaySection("voice"),
      connectSection("chat", { toolkits: ["gmail", "slack"] }),
      connectSection("voice"),
      consentSection("chat"),
      consentSection("voice"),
      dataFidelitySection("chat"),
      dataFidelitySection("voice"),
      hostIdentitySection("Testo"),
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

  it("chat genui keeps the shipped protocol text anchors", () => {
    expect(genuiFormatSection()).toContain("formatVersion: 'vendo-genui/v1'");
  });

  it("connect(chat) lists the provided toolkits; connect(voice) is the tools-present rule", () => {
    expect(connectSection("chat", { toolkits: ["gmail", "notion"] })).toContain("gmail, notion");
    expect(connectSection("voice")).toMatch(/IS connected/);
  });

  it("consent(voice) is the yes-recency rule (driver protocol lives in consent-strings)", () => {
    const s = consentSection("voice");
    expect(s).toMatch(/MOST RECENT permission request/);
  });

  it("consent carries the decline rule in both modalities: acknowledge, never re-propose", () => {
    for (const modality of ["chat", "voice"] as const) {
      const s = consentSection(modality);
      expect(s, modality).toMatch(/decline/i);
      expect(s, modality).toMatch(/never re-propose|never re-pitch/i);
      expect(s, modality).toMatch(/asks (for it )?again|asks again/i);
    }
  });

  it("data fidelity (chat): literal calendar dates, no guessed money divisor, totals match rows", () => {
    const s = dataFidelitySection("chat");
    expect(s).toContain("DATA FIDELITY");
    expect(s).toMatch(/YYYY-MM-DD/);
    expect(s).toMatch(/never timezone/i);
    expect(s).toMatch(/NEVER guess a divisor/i);
    // The ambiguity rule: money-suggesting names stay raw without a hint.
    expect(s).toMatch(/amount|total|balance/);
    expect(s).toMatch(/raw value/i);
    // The 100x stat-tile bug: summaries computed from the same values as rows.
    expect(s).toMatch(/rows it summarizes|same values/i);
  });

  it("data fidelity (voice) carries the same date and divisor rules", () => {
    const s = dataFidelitySection("voice");
    expect(s).toMatch(/YYYY-MM-DD/);
    expect(s).toMatch(/never guess a (money )?divisor/i);
  });

  it("host identity: the configured name is the ONLY name, inventing is forbidden", () => {
    const s = hostIdentitySection("Testo");
    expect(s).toContain('"Testo"');
    expect(s).toMatch(/ONLY/);
    expect(s).toMatch(/verbatim/i);
    expect(s).toMatch(/never invent/i);
    expect(s).toMatch(/substitute/i);
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

describe("data fidelity — summary strings", () => {
  it("covers pre-formatted summary strings (donut centerValue class) in both modalities", () => {
    for (const modality of ["chat", "voice"] as const) {
      const s = dataFidelitySection(modality);
      expect(s).toMatch(/summary string|pre-formatted/i);
      expect(s).toMatch(/convert(ed)? once|never .*(divide|convert).* again/i);
    }
  });
});
