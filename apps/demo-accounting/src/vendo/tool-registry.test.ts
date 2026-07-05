import { describe, expect, it } from "vitest";
import { resolveToolDescriptor } from "./tool-registry";
import { dangerTier, hashDescriptor, isUnverified, type ToolDescriptor } from "@vendoai/runtime";

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

  it("GRANT ROUND-TRIP: the resolver's Composio descriptor hash-matches the live-shaped engine descriptor", () => {
    // A consent-minted grant stores hashDescriptor(resolver descriptor); at
    // execute time grantPolicy hashes the LIVE descriptor, which the ingestion
    // path builds from the real `@composio/vercel` tool object — hasExecute
    // true (it has an execute) and possibly a different `kind`. Those runtime
    // mechanics are excluded from the hash projection {name, source,
    // annotations, executor}; annotations/executor parity is what this app
    // guarantees (see tool-registry.ts's parity note). Without the projection
    // (pre-review hashDescriptor hashed the whole struct) this test fails and
    // standing Composio grants silently never suppress.
    const resolved = resolveToolDescriptor("GMAIL_SEND_EMAIL")!;
    const liveShaped: ToolDescriptor = {
      name: "GMAIL_SEND_EMAIL",
      source: "composio",
      annotations: {},
      hasExecute: true,
      kind: "dynamic",
      executor: "server",
    };
    expect(hashDescriptor(resolved)).toBe(hashDescriptor(liveShaped));

    // Drift semantics preserved: an annotation difference must still lapse.
    expect(hashDescriptor(resolved)).not.toBe(
      hashDescriptor({ ...liveShaped, annotations: { destructiveHint: true } }),
    );
  });
});
