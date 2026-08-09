import { describe, expect, it } from "vitest";
import {
  grantSetDelta,
  intentHash,
  isBundleEligible,
  projectableForRun,
  VENUES,
  withheldFromUnattended,
  type AppIntent,
  type ToolDescriptor,
} from "./index.js";

const intent: AppIntent = {
  name: "Weekly invoice digest",
  triggerId: "main",
  tools: ["maple_invoices_list", "maple_email_draft"],
  trigger: { kind: "schedule", cron: "0 9 * * 1" },
  runBody: "Summarise last week's invoices and draft an email.",
};

const tool = (name: string, risk: ToolDescriptor["risk"]): ToolDescriptor => ({
  name,
  description: `${risk} tool`,
  inputSchema: { type: "object" },
  risk,
});

describe("intentHash (build contract §7)", () => {
  it("is insensitive to declared-tool ORDER — the same intent is one intent", () => {
    const reordered: AppIntent = { ...intent, tools: ["maple_email_draft", "maple_invoices_list"] };
    expect(intentHash(reordered)).toBe(intentHash(intent));
  });

  it("changes when any of the four components changes", () => {
    const base = intentHash(intent);
    expect(intentHash({ ...intent, name: "Weekly digest" })).not.toBe(base);
    expect(intentHash({ ...intent, tools: [...intent.tools, "maple_payments_send"] })).not.toBe(base);
    expect(intentHash({ ...intent, runBody: "Do something else entirely." })).not.toBe(base);
    expect(intentHash({ ...intent, trigger: { kind: "schedule", cron: "0 9 * * 2" } })).not.toBe(base);
  });

  it("is PER TRIGGER — two triggers of one app never share an intent", () => {
    // An app has a list of triggers and each is consented to on its own. Two
    // triggers that happen to declare identical tools and an identical run must
    // still hash apart, or one trigger's sponsorship would validate the other's.
    expect(intentHash({ ...intent, triggerId: "nightly" })).not.toBe(intentHash(intent));
  });

  it("ignores everything outside the four components — an unrelated edit keeps consent valid", () => {
    // Re-asking on a cosmetic change trains people to tap through cards.
    expect(intentHash({ ...intent, description: "notes" } as AppIntent)).toBe(intentHash(intent));
  });
});

describe("re-ask covers the delta only (E2g)", () => {
  it("does NOT re-ask for tools the person already granted", () => {
    const granted = ["maple_invoices_list", "maple_email_draft"];
    const declared = ["maple_invoices_list", "maple_email_draft", "maple_contacts_list"];

    const delta = grantSetDelta(granted, declared);

    expect(delta.added).toEqual(["maple_contacts_list"]);
    // The load-bearing half: the two already-approved tools are absent, so the
    // card cannot show them again.
    expect(delta.added).not.toContain("maple_invoices_list");
    expect(delta.added).not.toContain("maple_email_draft");
  });

  it("asks for nothing when the declared set is unchanged", () => {
    expect(grantSetDelta(["a", "b"], ["b", "a"]).added).toEqual([]);
  });

  it("reports a removed tool without asking about it — dropping a capability needs no consent", () => {
    const delta = grantSetDelta(["a", "b"], ["a"]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual(["b"]);
  });

  it("re-declaration may only ADD: a set that drops a tool is not a widening", () => {
    expect(grantSetDelta(["a", "b"], ["a", "c"])).toEqual({ added: ["c"], removed: ["b"] });
  });
});

describe("THE LAW: destructive and external actions are never unattended (§12)", () => {
  const tools = [
    tool("maple_invoices_list", "read"),
    tool("maple_invoice_update", "write"),
    tool("maple_payments_send", "destructive"),
  ];

  it("does not project a destructive tool into an automation run AT ALL", () => {
    const projected = projectableForRun(tools, { venue: "automation", presence: "away" });

    expect(projected.map((t) => t.name)).toEqual(["maple_invoices_list", "maple_invoice_update"]);
  });

  it("still projects reads and writes into an automation run", () => {
    const projected = projectableForRun(tools, { venue: "automation", presence: "away" });
    expect(projected.map((t) => t.risk)).toEqual(["read", "write"]);
  });

  it("projects everything when a person is present — interactively it is a normal confirm", () => {
    const projected = projectableForRun(tools, { venue: "chat", presence: "present" });
    expect(projected).toHaveLength(3);
  });

  it("projects by the DECLARED label alone — the dev's label is final", () => {
    // The two-vote risk grading is gone: no name or method heuristic second-
    // guesses the label a dev shipped and reviewed. A `read` named like a
    // deletion is a read.
    const labelled = [tool("maple_customer_delete", "read")];
    expect(projectableForRun(labelled, { venue: "automation", presence: "away" }))
      .toEqual(labelled);
  });

  it("withholds an UNGRADED tool from an unattended run — unlabeled means asks, and away has nobody to ask", () => {
    const ungraded = [tool("maple_frobnicate_widget", "ungraded")];
    expect(withheldFromUnattended(ungraded[0]!)).toBe(true);
    expect(projectableForRun(ungraded, { venue: "automation", presence: "away" })).toEqual([]);
  });

  // The predicate is PRESENCE, never the venue label (§12 clarification
  // 2026-07-31). Both halves sweep EVERY venue, and the venue list is derived
  // from core's own `VENUES` rather than written out here — a fifth venue is
  // added in one place and is swept by both halves the moment it exists.
  //
  // Both halves are load-bearing, and the AWAY half alone is not a lock: every
  // away case already satisfies a presence-only predicate, so `presence ===
  // "away" || venue === "<anything>"` leaves it green. The PRESENT half is the
  // one behavioural difference a venue clause makes, which is why it sweeps too.
  it.each(VENUES)(
    "withholds destructive tools from an away run in venue %s — relabelling the venue cannot regain projection",
    (venue) => {
      const projected = projectableForRun(tools, { venue, presence: "away" });
      expect(projected.map((t) => t.name)).toEqual(["maple_invoices_list", "maple_invoice_update"]);
    },
  );

  it.each(VENUES)(
    "projects destructive tools to a PRESENT person in venue %s — a ceremony must see what it asks about",
    (venue) => {
      // `{ venue: "automation", presence: "present" }` is the enable/capture
      // flow and the "allow this while you're away" approval card: a human is
      // right there clicking. Filtering here made the ceremony unable to ask
      // about the very tools it exists to ask about ("unknown tool in
      // automation"). No other venue may acquire that bug either.
      const projected = projectableForRun(tools, { venue, presence: "present" });

      expect(projected.map((t) => t.name)).toEqual([
        "maple_invoices_list",
        "maple_invoice_update",
        "maple_payments_send",
      ]);
    },
  );
});

describe("bundles are proposed, never blank (§12)", () => {
  it("rejects a whole-registry declaration instead of bundling it", () => {
    const registry = ["a", "b", "c", "d"];
    expect(isBundleEligible(["a", "b", "c", "d"], registry, [
      tool("a", "read"), tool("b", "read"), tool("c", "read"), tool("d", "read"),
    ])).toBe(false);
  });

  it("is bundle-eligible when every member is a read or a non-destructive write", () => {
    const registry = ["a", "b", "c", "d"];
    expect(isBundleEligible(["a", "b"], registry, [tool("a", "read"), tool("b", "write")])).toBe(true);
  });

  it("is NOT bundle-eligible when any member is destructive", () => {
    const registry = ["a", "b", "c", "d"];
    expect(isBundleEligible(["a", "b"], registry, [tool("a", "read"), tool("b", "destructive")])).toBe(false);
  });
});

describe("presence-only tools: nothing rearranges a page nobody is looking at", () => {
  const surface = [
    tool("vendo_make", "read"),
    tool("vendo_apps_pin", "write"),
    tool("vendo_apps_unpin", "write"),
    tool("maple_invoice_update", "write"),
  ];

  it("withholds the placement pair from an unattended run", () => {
    const projected = projectableForRun(surface, { venue: "automation", presence: "away" });

    expect(projected.map((t) => t.name)).toEqual(["vendo_make", "maple_invoice_update"]);
  });

  it("keys the rule on the NAME, not the grade — another write is untouched", () => {
    // Their risk is honestly `write`: a placement row is small and reversible,
    // and needs no ceremony with a person right there. So the withholding cannot
    // ride the risk label, and this is the assertion that says so.
    const projected = projectableForRun(surface, { venue: "automation", presence: "away" });

    expect(projected.map((t) => t.risk)).toEqual(["read", "write"]);
  });

  it("offers them to a person who is present", () => {
    const projected = projectableForRun(surface, { venue: "chat", presence: "present" });

    expect(projected).toHaveLength(4);
  });
});
