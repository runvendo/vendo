import { describe, expect, it } from "vitest";
import { resolveToolDescriptor } from "./tool-registry";
import { dangerTier, isUnverified } from "@flowlet/runtime";

describe("resolveToolDescriptor", () => {
  it("Cadence host tools carry their real OpenAPI-derived annotations", () => {
    const d = resolveToolDescriptor("sendClientMessage");
    expect(d).toBeDefined();
    expect(dangerTier(d!)).toBe("act");
  });

  it("automation-authoring critical tools resolve as critical", () => {
    const d = resolveToolDescriptor("create_automation");
    expect(d).toBeDefined();
    expect(dangerTier(d!)).toBe("critical");
  });

  it("Composio-ingested tools resolve act+unverified (no live schema fetch needed for tier purposes)", () => {
    const d = resolveToolDescriptor("GMAIL_SEND_EMAIL");
    expect(d).toBeDefined();
    expect(dangerTier(d!)).toBe("act");
    expect(isUnverified(d!)).toBe(true);
  });

  it("unknown tool name resolves undefined", () => {
    expect(resolveToolDescriptor("not_a_real_tool")).toBeUndefined();
  });
});
