/**
 * One definition of the destructive-verb vocabulary.
 *
 * The words that mean "this moves money, messages a human, or destroys
 * something" are security-relevant, and they used to be written down twice: once
 * in `@vendoai/core` (the runtime's second mechanical vote, `mechanicalRisk`) and
 * once here (build-time extraction). Two definitions of one safety vocabulary
 * drift, and the drift is silent — a verb added to the runtime's list still
 * extracted as a plain `write`.
 *
 * Core is the source of truth. The two VOTES stay independent on purpose (core
 * discriminates noun-from-verb by position; extraction has no HTTP verb to lean
 * on for tRPC/server-actions and matches membership anywhere), so this file
 * pins the DATA being shared, not the algorithms.
 */
import { DESTRUCTIVE_VERBS, READ_VERBS } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { extractedRisk, serverActionRisk, trpcRisk } from "./common.js";

describe("extraction reads its destructive vocabulary from core", () => {
  // Verbs core has always carried that the old local list omitted. Each is a
  // real host-API shape, and each was extracted as a plain `write` before.
  const CORE_ONLY = ["pay", "refund", "withdraw", "terminate", "suspend", "notify", "deploy"];

  it("core owns every verb these votes match on", () => {
    for (const verb of CORE_ONLY) expect(DESTRUCTIVE_VERBS.has(verb)).toBe(true);
  });

  it("labels a route whose verb is only in core's list destructive", () => {
    for (const verb of CORE_ONLY) {
      expect(extractedRisk("POST", `host_invoice_${verb}`, "route")).toBe("destructive");
    }
  });

  it("labels a tRPC mutation whose verb is only in core's list destructive", () => {
    for (const verb of CORE_ONLY) {
      expect(trpcRisk("mutation", `invoice.${verb}`)).toBe("destructive");
    }
  });

  it("labels a server action whose verb is only in core's list destructive", () => {
    for (const verb of CORE_ONLY) {
      expect(serverActionRisk(`${verb}Invoice`)).toBe("destructive");
    }
  });

  it("keeps reading core's read vocabulary too, so one list governs both sides", () => {
    // `lookup` and `view` are core's; the old local read list stopped at `count`.
    expect(READ_VERBS.has("lookup")).toBe(true);
    expect(extractedRisk("GET", "host_invoice_lookup", "openapi")).toBe("read");
  });
});
